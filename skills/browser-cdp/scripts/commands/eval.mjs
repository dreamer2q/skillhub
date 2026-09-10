#!/usr/bin/env node
/**
 * eval.js — 在浏览器指定 tab 中执行 JS
 * 用法：eval.js --url <url-pattern> '<expression>'
 */

import http from "http";
import { CDP_HOST, CDP_PORT, findTab, evaluate } from "../lib/cdp.mjs";

const TIMEOUT_MS = 15000;

// ── 参数解析 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");

if (urlIdx === -1) {
	console.error("✗ Missing required --url parameter");
	console.error("  Usage: eval.js --url <url-pattern> '<expression>'");
	process.exit(1);
}

const urlFilter = args[urlIdx + 1];
if (!urlFilter || urlFilter.startsWith("'") || urlFilter.startsWith('"')) {
	console.error("✗ --url requires a value (e.g. --url example.com)");
	process.exit(1);
}

const codeArgs = args.filter((_, i) => i !== urlIdx && i !== urlIdx + 1);
const code = codeArgs.join(" ");

if (!code) {
	console.error("✗ Missing expression to evaluate");
	console.error("  Usage: eval.js --url <url-pattern> '<expression>'");
	process.exit(1);
}

// ── 获取 tab 列表（用于错误提示）────────────────────────────────────────────

const getAllTabs = () =>
	new Promise((resolve, reject) => {
		http.get({ host: CDP_HOST, port: CDP_PORT, path: "/json" }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				try { resolve(JSON.parse(data)); }
				catch { resolve([]); }
			});
		}).on("error", reject);
	});

// ── 查找 tab ──────────────────────────────────────────────────────────────────

const tab = await findTab(urlFilter);

if (!tab) {
	let tabs = [];
	try { tabs = await getAllTabs(); } catch {}
	const hasErrorPage = tabs.some((t) => t.url?.startsWith("chrome-error://"));
	console.error(`✗ No tab matching "${urlFilter}" found`);
	if (hasErrorPage) {
		console.error(`  Detected chrome-error:// tab(s) — page may have failed to load (network error, DNS failure, etc.)`);
	}
	const openUrls = tabs.filter((t) => t.type === "page").map((t) => t.url);
	console.error(`  Open tabs:\n  ${openUrls.join("\n  ")}`);
	process.exit(1);
}

// ── 执行 ──────────────────────────────────────────────────────────────────────

// 超时：主线程 setTimeout，不依赖页面事件循环
const timer = setTimeout(() => {
	console.error(`✗ Timed out after ${TIMEOUT_MS}ms on tab: ${tab.url}`);
	console.error(`  Possible causes: fetch pending, page navigating, or JS blocked.`);
	console.error(`  → Stop retrying. Report to user and wait for instructions.`);
	process.exit(1);
}, TIMEOUT_MS);

let result;
try {
	result = await evaluate(tab.id, code, { timeoutMs: TIMEOUT_MS - 1000 });
	clearTimeout(timer);
} catch (err) {
	clearTimeout(timer);
	if (err.message.includes("EVAL_TIMEOUT")) {
		console.error(`✗ Timed out after ${TIMEOUT_MS}ms on tab: ${tab.url}`);
		console.error(`  Possible causes: fetch pending, page navigating, or JS blocked.`);
		console.error(`  → Stop retrying. Report to user and wait for instructions.`);
	} else {
		console.error(`✗ ${err.message}`);
	}
	process.exit(1);
}

// ── 输出 ──────────────────────────────────────────────────────────────────────

if (Array.isArray(result)) {
	for (let i = 0; i < result.length; i++) {
		if (i > 0) console.log("");
		for (const [k, v] of Object.entries(result[i])) console.log(`${k}: ${v}`);
	}
} else if (typeof result === "object" && result !== null) {
	for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`);
} else {
	console.log(result);
}
