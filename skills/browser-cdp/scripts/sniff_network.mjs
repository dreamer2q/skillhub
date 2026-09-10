#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [join(scriptDir, "cdp.mjs"), "sniff", ...process.argv.slice(2)], {
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
