#!/usr/bin/env node
/**
 * sniff_network.mjs — observe XHR/fetch traffic from an existing Chrome tab.
 *
 * Usage:
 *   node scripts/sniff_network.mjs --url <url-pattern> [--filter <keyword>] [--duration 30] [--with-body] [--with-response] [--reload] [--json]
 */

import { connectWs, findTab, sendCmd } from "../lib/cdp.mjs";
import { collectFilters, parseArgs } from "../lib/args.mjs";
import { createNetworkObserver } from "../lib/network.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
	console.error("Usage: sniff_network.mjs --url <url-pattern> [--filter <keyword>] [--duration 30] [--with-body] [--with-response] [--reload] [--json]");
	process.exit(1);
}

const tab = await findTab(args.url);
if (!tab) {
	console.error(`No tab matching URL pattern: ${args.url}`);
	process.exit(1);
}

const durationMs = Math.max(1, args.duration || 30) * 1000;
const ws = await connectWs(tab.webSocketDebuggerUrl);
const events = [];

function output(event) {
	events.push(event);
	if (args.json) return;

	const status = event.status == null ? "?" : event.status;
	const body = event.requestBody ? ` body=${event.requestBody.slice(0, 120)}` : "";
	const response = event.responseBody ? ` response=${event.responseBody.slice(0, 160)}` : "";
	console.log(`${event.method} ${event.url} [${status}]${body}${response}`);
}

const network = createNetworkObserver(ws, {
	filters: collectFilters(args.filter),
	withBody: Boolean(args["with-body"]),
	withResponse: Boolean(args["with-response"]),
	onEvent: output,
});

await network.enable();
if (!args.json) {
	console.error(`Listening on ${tab.url} for ${durationMs / 1000}s ...`);
	console.error("Note: sniff only observes requests after this point; an empty result does not prove no request happened.");
}

if (args.reload) {
	try {
		await sendCmd(ws, "Page.enable");
		await sendCmd(ws, "Page.reload", { ignoreCache: true });
		if (!args.json) console.error("Reload triggered after Network.enable.");
	} catch (error) {
		console.error(`Reload failed: ${error.message}`);
	}
}

await new Promise((resolve) => setTimeout(resolve, durationMs));
network.dispose();
ws.close();

if (args.json) {
	console.log(JSON.stringify(events, null, 2));
} else if (events.length === 0) {
	console.error("No matching network events during the sniff window. Use --reload before drawing conclusions, or inspect performance entries for already-completed SPA requests.");
}
