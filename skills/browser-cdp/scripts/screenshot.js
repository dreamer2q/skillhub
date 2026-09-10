#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const result = spawnSync(process.execPath, [join(__dirname, "cdp.mjs"), "screenshot", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: {
		...process.env,
		NO_PROXY: [process.env.NO_PROXY, process.env.CDP_HOST || "127.0.0.1", "127.0.0.1", "localhost"].filter(Boolean).join(","),
	},
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
