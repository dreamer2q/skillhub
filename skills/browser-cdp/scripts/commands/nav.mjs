#!/usr/bin/env node
/**
 * nav.js — 导航到指定 URL
 * 用法：nav.js <url> [--new]
 *   --new  在新 tab 中打开
 */

import { getTabs, navigate, openTab } from "../lib/cdp.mjs";

const url = process.argv[2];
const newTab = process.argv[3] === "--new";

if (!url) {
	console.log("Usage: nav.js <url> [--new]");
	console.log("\nExamples:");
	console.log("  nav.js https://example.com       # Navigate current tab");
	console.log("  nav.js https://example.com --new # Open in new tab");
	process.exit(1);
}

if (newTab) {
	const targetId = await openTab(url);
	// openTab via /json/new 会自动导航，等待 domContentLoaded
	await navigate(targetId, url);
	console.log(`✓ Opened: ${url}`);
} else {
	// 导航到最后一个 page tab
	const tabs = await getTabs();
	const last = tabs.at(-1);
	if (!last) {
		console.error("✗ No open tab found");
		process.exit(1);
	}
	await navigate(last.id, url);
	console.log(`✓ Navigated to: ${url}`);
}
