/**
 * cdp.mjs — 原生 CDP 封装库（零依赖，Node.js 22+ 内置 WebSocket + fetch）
 *
 * 提供：
 *   getTabs()                        — 获取所有 page tab
 *   findTab(urlFilter)               — 按 URL 匹配 tab，未找到返回 null
 *   openTab(url?)                    — 新开 tab，可选导航到 url
 *   navigate(targetId, url)          — 在指定 tab 导航
 *   evaluate(targetId, code, msOpts) — 执行 JS（带超时）
 *   screenshot(targetId)             — 截图，返回 base64 PNG
 *   closeTab(targetId)               — 关闭 tab
 */

export const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
export const CDP_PORT = Number(process.env.CDP_PORT || 9222);
export const BASE = `http://${CDP_HOST}:${CDP_PORT}`;

function appendNoProxy(env, key, hosts) {
	const existing = (env[key] || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const seen = new Set(existing.map((entry) => entry.toLowerCase()));
	for (const host of hosts) {
		if (!host || seen.has(host.toLowerCase())) continue;
		existing.push(host);
		seen.add(host.toLowerCase());
	}
	env[key] = existing.join(",");
}

export function ensureCdpNoProxyEnv(env = process.env) {
	appendNoProxy(env, "NO_PROXY", [CDP_HOST, "127.0.0.1", "localhost", "::1"]);
	appendNoProxy(env, "no_proxy", [CDP_HOST, "127.0.0.1", "localhost", "::1"]);
}

ensureCdpNoProxyEnv();

// ── HTTP ──────────────────────────────────────────────────────────────────────

export async function cdpHttp(path, method = "GET", body) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	try { return JSON.parse(text); } catch { return text; }
}

export async function getTabs() {
	const targets = await cdpHttp("/json");
	return targets.filter((t) => t.type === "page");
}

export async function findTab(urlFilter) {
	const tabs = await getTabs();
	return tabs.find((t) => t.url?.includes(urlFilter)) ?? null;
}

export async function closeTab(targetId) {
	await cdpHttp(`/json/close/${targetId}`);
}

// ── WebSocket session ─────────────────────────────────────────────────────────

export function connectWs(wsUrl) {
	return new Promise((resolve, reject) => {
		const url = new URL(wsUrl);
		if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
			url.hostname = CDP_HOST;
		}
		const ws = new WebSocket(url.toString());
		const timer = setTimeout(() => reject(new Error(`WS connect timeout: ${wsUrl}`)), 5000);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.addEventListener("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`WS connect failed: ${e.message ?? wsUrl}`));
		});
	});
}

export function sendCmd(ws, method, params = {}) {
	const id = Math.floor(Math.random() * 1e9);
	return new Promise((resolve, reject) => {
		const onMsg = ({ data }) => {
			let msg;
			try { msg = JSON.parse(data); } catch { return; }
			if (msg.id !== id) return;
			ws.removeEventListener("message", onMsg);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		};
		ws.addEventListener("message", onMsg);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

// ── evaluate ─────────────────────────────────────────────────────────────────

/**
 * 在指定 tab 执行 JS 表达式，返回结果值。
 * @param {string} targetId
 * @param {string} code       — 单个表达式或 async IIFE
 * @param {object} opts
 * @param {number} opts.timeoutMs  — 超时毫秒，默认 15000
 */
export async function evaluate(targetId, code, { timeoutMs = 15000 } = {}) {
	const tabs = await getTabs();
	const tab = tabs.find((t) => t.id === targetId);
	if (!tab) throw new Error(`Tab not found: ${targetId}`);

	const ws = await connectWs(tab.webSocketDebuggerUrl);

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`EVAL_TIMEOUT after ${timeoutMs}ms`));
		}, timeoutMs);

		sendCmd(ws, "Runtime.evaluate", {
			expression: `(async () => { return (${code}) })()`,
			awaitPromise: true,
			returnByValue: true,
		})
			.then((res) => {
				clearTimeout(timer);
				ws.close();
				if (res.exceptionDetails) {
					const ex = res.exceptionDetails;
					reject(new Error(`JS exception: ${ex.exception?.description || ex.text}`));
				} else {
					resolve(res.result?.value);
				}
			})
			.catch((err) => {
				clearTimeout(timer);
				ws.close();
				reject(err);
			});
	});
}

// ── navigate ─────────────────────────────────────────────────────────────────

/**
 * 在指定 tab 导航到 url，等待 DOMContentLoaded。
 * @param {string} targetId
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.timeoutMs
 */
export async function navigate(targetId, url, { timeoutMs = 30000 } = {}) {
	const tabs = await getTabs();
	const tab = tabs.find((t) => t.id === targetId);
	if (!tab) throw new Error(`Tab not found: ${targetId}`);

	const ws = await connectWs(tab.webSocketDebuggerUrl);

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`NAV_TIMEOUT after ${timeoutMs}ms: ${url}`));
		}, timeoutMs);

		// 启用 Page 事件
		sendCmd(ws, "Page.enable")
			.then(() => {
				// 监听 frameStoppedLoading（比 domContentEventFired 更可靠）
				ws.addEventListener("message", ({ data }) => {
					let msg;
					try { msg = JSON.parse(data); } catch { return; }
					if (msg.method === "Page.frameStoppedLoading" || msg.method === "Page.loadEventFired") {
						clearTimeout(timer);
						ws.close();
						resolve();
					}
				});
				return sendCmd(ws, "Page.navigate", { url });
			})
			.catch((err) => {
				clearTimeout(timer);
				ws.close();
				reject(err);
			});
	});
}

// ── openTab ───────────────────────────────────────────────────────────────────

/**
 * 新开一个 tab，可选导航到 url。返回新 tab 的 targetId。
 */
export async function openTab(url) {
	// CDP /json/new 会新建 tab 并可选导航
	const target = await cdpHttp(`/json/new${url ? `?${encodeURIComponent(url)}` : ""}`, "PUT");
	return target.id;
}

// ── screenshot ────────────────────────────────────────────────────────────────

/**
 * 截图，返回 base64 编码的 PNG 字符串。
 */
export async function screenshot(targetId) {
	const tabs = await getTabs();
	const tab = tabs.find((t) => t.id === targetId);
	if (!tab) throw new Error(`Tab not found: ${targetId}`);

	const ws = await connectWs(tab.webSocketDebuggerUrl);
	try {
		const res = await sendCmd(ws, "Page.captureScreenshot", { format: "png" });
		return res.data; // base64
	} finally {
		ws.close();
	}
}
