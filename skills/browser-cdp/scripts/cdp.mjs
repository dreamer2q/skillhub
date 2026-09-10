#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const commandDir = join(scriptDir, "commands");

const commands = {
	start: "start.mjs",
	nav: "nav.mjs",
	eval: "eval.mjs",
	screenshot: "screenshot.mjs",
	sniff: "sniff.mjs",
	"sniff-network": "sniff.mjs",
	sniff_network: "sniff.mjs",
	record: "record.mjs",
	parse: "parse-record.mjs",
	"parse-record": "parse-record.mjs",
	dump: "dump-env.mjs",
	"dump-env": "dump-env.mjs",
	dump_env: "dump-env.mjs",
};

function printHelp() {
	console.log(`Usage: cdp.mjs <command> [args]

Commands:
  start        start or reuse Chrome CDP, default :9222
  nav          navigate current tab or open a new tab
  eval         evaluate JavaScript in a matching tab
  screenshot   capture a tab screenshot
  sniff        observe XHR/fetch traffic
  record       record user actions and network events
  parse        parse a record JSONL file
  dump         print Chrome/tab environment snapshot

Examples:
  node scripts/cdp.mjs start --profile
  node scripts/cdp.mjs nav https://example.com --new
  node scripts/cdp.mjs eval --url example.com "document.title"
  node scripts/cdp.mjs sniff --url example.com --filter /api/ --duration 30
`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "-h" || command === "--help") {
	printHelp();
	process.exit(command ? 0 : 1);
}

const script = commands[command];
if (!script) {
	console.error(`Unknown command: ${command}`);
	printHelp();
	process.exit(1);
}

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

const env = {
	...process.env,
};
const noProxyHosts = [env.CDP_HOST || "127.0.0.1", "127.0.0.1", "localhost", "::1"];
appendNoProxy(env, "NO_PROXY", noProxyHosts);
appendNoProxy(env, "no_proxy", noProxyHosts);

const result = spawnSync(process.execPath, [join(commandDir, script), ...args], {
	stdio: "inherit",
	env,
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status ?? 1);
