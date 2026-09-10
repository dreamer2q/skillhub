#!/usr/bin/env node
/**
 * commands/start.mjs — 启动独立 Chrome 实例，监听 CDP
 *
 * 用法：start.js [--profile|--no-profile]
 *   （无参数）/ --profile  默认从系统 Chrome 同步 Cookie 等登录文件，保留登录态
 *   --no-profile           跳过登录态同步，以匿名模式启动
 *
 * 设计原则：
 *   - CDP 已在目标端口运行时直接复用，不重启，不 pkill 任何进程
 *   - 独立 --user-data-dir，不影响用户正在使用的系统 Chrome
 *
 * 环境变量：
 *   CDP_HOST             覆盖 CDP 主机（默认 127.0.0.1；start 只支持本机）
 *   CDP_PORT             覆盖 CDP 端口（默认 9222）
 *   CHROME_PATH          覆盖 Chrome 可执行文件路径
 *   CHROME_USER_DATA_DIR 覆盖用户数据目录
 */

import { spawn } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import http from "node:http";
import { CDP_HOST, CDP_PORT } from "../lib/cdp.mjs";

const mode = process.argv[2] ?? "--profile";
if (!["--profile", "--no-profile"].includes(mode)) {
	console.log("Usage: start.js [--profile|--no-profile]");
	process.exit(1);
}

function isLocalHost(host) {
	return ["127.0.0.1", "localhost", "::1"].includes(host);
}

// ── CDP 检测（最先执行，已就绪直接退出） ──────────────────────────────────────

const checkCdp = () =>
	new Promise((resolve) => {
		http.get(`http://${CDP_HOST}:${CDP_PORT}/json/version`, (res) => {
			const ok = res.statusCode === 200;
			res.resume();
			res.on("end", () => resolve(ok));
			res.on("error", () => resolve(false));
		}).on("error", () => resolve(false));
	});

if (await checkCdp()) {
	console.log(`✓ Chrome CDP already running on :${CDP_PORT}`);
	process.exit(0);
}

if (!isLocalHost(CDP_HOST)) {
	console.error(`✗ Cannot start local Chrome for non-local CDP_HOST=${CDP_HOST}`);
	console.error("  Start Chrome on that host first, or unset CDP_HOST to use local Chrome.");
	process.exit(1);
}

// ── 以下仅在 CDP 未就绪时执行 ────────────────────────────────────────────────

// --profile 未传时也默认同步登录态，避免独立实例每次都要重新登录
const useProfile = mode !== "--no-profile";

// ── Chrome 路径探测 ────────────────────────────────────────────────────────────

const CHROME_CANDIDATES = platform() === "darwin"
	? [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	]
	: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];

function findChrome() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	for (const p of CHROME_CANDIDATES) {
		if (existsSync(p)) return p;
	}
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		const found = findExecutableInPath(name);
		if (found) return found;
	}
	return null;
}

function findExecutableInPath(name) {
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

const chromePath = findChrome();
if (!chromePath) {
	console.error("✗ Chrome not found. Set CHROME_PATH env or install Chrome/Chromium.");
	process.exit(1);
}

// ── 用户数据目录（独立，不与系统 Chrome 共享） ────────────────────────────────

const userDataDir = process.env.CHROME_USER_DATA_DIR
	?? join(homedir(), ".cache", "browser-cdp", CDP_PORT === 9222 ? "profile" : `profile-${CDP_PORT}`);

mkdirSync(userDataDir, { recursive: true });

// ── 同步登录态（默认开启，--no-profile 跳过） ─────────────────────────────────

if (useProfile) {
	const systemProfile = platform() === "darwin"
		? join(homedir(), "Library", "Application Support", "Google", "Chrome")
		: join(homedir(), ".config", "google-chrome");

	if (existsSync(systemProfile)) {
		console.log("Syncing login data from system Chrome profile ...");
		copyProfileFiles(systemProfile, userDataDir);
	}
}

function copyProfileFiles(sourceDir, targetDir) {
	const entries = [
		"Local State",
		join("Default", "Cookies"),
		join("Default", "Network", "Cookies"),
		join("Default", "Login Data"),
		join("Default", "Web Data"),
		join("Default", "Local State"),
	];

	for (const entry of entries) {
		const src = join(sourceDir, entry);
		if (!existsSync(src)) continue;
		const dest = join(targetDir, entry);
		mkdirSync(dirname(dest), { recursive: true });
		try {
			cpSync(src, dest, { recursive: true, force: true });
		} catch (error) {
			console.error(`  Warn: failed to copy ${entry}: ${error.message}`);
		}
	}
}

// ── 启动独立 Chrome 实例 ──────────────────────────────────────────────────────

const chromeArgs = [
	`--remote-debugging-port=${CDP_PORT}`,
	`--user-data-dir=${userDataDir}`,
	"--no-first-run",
	"--no-default-browser-check",
];

if (platform() === "linux") {
	chromeArgs.push("--disable-dev-shm-usage");
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		chromeArgs.push("--no-sandbox");
	}
}

if (process.env.CHROME_FLAGS) {
	chromeArgs.push(...process.env.CHROME_FLAGS.split(/\s+/).filter(Boolean));
}

spawn(
	chromePath,
	chromeArgs,
	{ detached: true, stdio: "ignore" },
).unref();

// ── 等待 CDP 就绪（最多 30 秒） ───────────────────────────────────────────────

let connected = false;
for (let i = 0; i < 60; i++) {
	if (await checkCdp()) { connected = true; break; }
	await new Promise((r) => setTimeout(r, 500));
}

if (!connected) {
	console.error(`✗ Failed to connect to Chrome on :${CDP_PORT}`);
	process.exit(1);
}

console.log(`✓ Chrome started on :${CDP_PORT}${useProfile ? " (with profile)" : ""}`);
console.log(`  User data dir: ${userDataDir}`);
