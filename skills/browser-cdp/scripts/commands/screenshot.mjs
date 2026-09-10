#!/usr/bin/env node
/**
 * screenshot.js — 截图
 * 用法：screenshot.js [--url <pattern>] [--output <path>]
 */

import { writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTabs, findTab, screenshot } from "../lib/cdp.mjs";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const urlPattern = urlIdx !== -1 ? args[urlIdx + 1] : null;
const outputIdx = args.indexOf("--output");
const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

let tab;
if (urlPattern) {
	tab = await findTab(urlPattern);
	if (!tab) {
		const tabs = await getTabs();
		console.error(`✗ No tab matching URL pattern: ${urlPattern}`);
		console.error(`  Available tabs:\n${tabs.map((t) => `  - ${t.url}`).join("\n")}`);
		process.exit(1);
	}
} else {
	const tabs = await getTabs();
	tab = tabs.at(-1);
}

if (!tab) {
	console.error("✗ No active tab found");
	process.exit(1);
}

const base64 = await screenshot(tab.id);
const buf = Buffer.from(base64, "base64");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `screenshot-${timestamp}.png`;
const filepath = outputPath || join(tmpdir(), filename);

writeFileSync(filepath, buf);
console.log(filepath);
