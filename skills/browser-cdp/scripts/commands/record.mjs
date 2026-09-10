#!/usr/bin/env node
/**
 * record.mjs — zero-dependency CDP page interaction recorder.
 *
 * Usage:
 *   node scripts/record.mjs --url <start-url> [--end-url <pattern>] [--timeout 300] [--output <file>] [--observe-mutations]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	closeTab,
	connectWs,
	getTabs,
	navigate,
	openTab,
	sendCmd,
} from "../lib/cdp.mjs";
import { createNetworkObserver } from "../lib/network.mjs";

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
		args[key] = val;
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
	console.error("Usage: record.mjs --url <url> [--end-url <pattern>] [--timeout 300] [--output session.jsonl]");
	process.exit(1);
}

const startUrl = args.url;
const endUrlPattern = args["end-url"] || null;
const observeMutations = Boolean(args["observe-mutations"]);
const timeoutMs = Math.max(1, Number(args.timeout || 300)) * 1000;
const recordDir = path.join(os.homedir(), ".cache", "browser-cdp", "record");
const lockFile = path.join(recordDir, "session.lock");
const outputFile = args.output
	? path.resolve(args.output)
	: path.join(recordDir, `session-${Date.now()}.jsonl`);

fs.mkdirSync(recordDir, { recursive: true });
fs.mkdirSync(path.dirname(outputFile), { recursive: true });

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code === "EPERM";
	}
}

if (fs.existsSync(lockFile)) {
	try {
		const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		if (isProcessAlive(lock.pid)) {
			console.error(`Already recording: pid=${lock.pid}`);
			console.error(`Lock: ${lockFile}`);
			console.error(`Output: ${lock.output || "(unknown)"}`);
			process.exit(1);
		}
		fs.unlinkSync(lockFile);
	} catch {
		try { fs.unlinkSync(lockFile); } catch {}
	}
}

fs.writeFileSync(lockFile, JSON.stringify({
	pid: process.pid,
	startTime: Date.now(),
	startUrl,
	output: outputFile,
}));

const out = fs.createWriteStream(outputFile, { flags: "a" });
let ws = null;
let network = null;
let targetId = null;
let finished = false;
let timeoutHandle = null;

function emit(event) {
	out.write(`${JSON.stringify({ t: Date.now(), ...event })}\n`);
}

function removeLock() {
	try {
		const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		if (lock.pid === process.pid) fs.unlinkSync(lockFile);
	} catch {
		try { fs.unlinkSync(lockFile); } catch {}
	}
}

async function finish(reason, exitCode = 0) {
	if (finished) return;
	finished = true;
	if (timeoutHandle) clearTimeout(timeoutHandle);
	emit({ type: "meta", status: "done", endReason: reason, output: outputFile });

	await new Promise((resolve) => out.end(resolve));
	removeLock();

	try { if (network) network.dispose(); } catch {}
	try { if (ws) ws.close(); } catch {}
	if (targetId) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		try { await closeTab(targetId); } catch {}
	}

	console.error(`record done: ${reason}`);
	console.error(`output: ${outputFile}`);
	process.exit(exitCode);
}

process.on("SIGINT", () => { void finish("sigint"); });
process.on("SIGTERM", () => { void finish("sigterm"); });
process.on("uncaughtException", (error) => {
	console.error(error);
	void finish("uncaught-exception", 1);
});
process.on("unhandledRejection", (error) => {
	console.error(error);
	void finish("unhandled-rejection", 1);
});

const STOP_BUTTON_SCRIPT = `
(function installRecordStopButton() {
  function install() {
    if (!document.body || document.getElementById('__record_stop_btn')) return;
    const box = document.createElement('div');
    box.id = '__record_stop_btn';
    box.innerHTML = 'REC <button id="__record_stop_btn_action">Stop & Save</button>';
    Object.assign(box.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      background: '#1a1a1a',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '6px',
      fontSize: '13px',
      fontFamily: 'monospace',
      boxShadow: '0 2px 8px rgba(0,0,0,0.35)'
    });
    const button = box.querySelector('button');
    button.style.cssText = 'margin-left:8px;background:#d33;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    button.addEventListener('click', function() {
      box.textContent = 'Saved. Closing tab...';
      box.style.background = '#276749';
      if (window.__recordStop) window.__recordStop('stop-button');
    });
    document.body.appendChild(box);
  }
  install();
  if (!document.body) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
`;

const DOM_LISTENER_SCRIPT = `
(function installRecordListeners() {
  if (window.__recordListening) return;
  window.__recordListening = true;
  window.__recordObserveMutations = ${observeMutations ? "true" : "false"};

  function send(event) {
    if (window.__recordEvent) window.__recordEvent(JSON.stringify(event));
  }

  function selector(el) {
    if (!el || el === document || el === window) return 'document';
    if (el === document.body) return 'body';
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 5; depth++, cur = cur.parentElement) {
      let part = cur.tagName ? cur.tagName.toLowerCase() : 'node';
      if (cur.id) {
        parts.unshift('#' + cur.id);
        break;
      }
      const classes = Array.from(cur.classList || [])
        .filter((c) => !/^(active|hover|focus|selected|is-)/.test(c))
        .slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      parts.unshift(part);
    }
    return parts.join(' > ') || 'document';
  }

  function label(el) {
    return String(
      el?.getAttribute?.('aria-label') ||
      el?.getAttribute?.('placeholder') ||
      el?.getAttribute?.('title') ||
      el?.innerText ||
      el?.textContent ||
      ''
    ).trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  function snap(node, limit) {
    if (!node || !node.outerHTML) return undefined;
    const html = node.outerHTML;
    return html.length > limit ? html.slice(0, limit) + '...' : html;
  }

  document.addEventListener('click', function(event) {
    const el = event.target;
    send({
      type: 'click',
      selector: selector(el),
      tag: el?.tagName?.toLowerCase(),
      label: label(el),
      domSnapshot: {
        target: snap(el, 300),
        parent: snap(el?.parentElement, 600)
      }
    });

    if (!window.__recordObserveMutations) return;
    const changes = new Map();
    const observer = new MutationObserver(function(records) {
      for (const record of records) {
        let key = record.target;
        for (let i = 0; i < 5 && key && key !== document.body; i++) {
          if (key.id || (typeof key.className === 'string' && key.className.trim())) break;
          key = key.parentElement;
        }
        if (!key) continue;
        changes.set(key, (changes.get(key) || 0) + record.addedNodes.length + 1);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(function() {
      observer.disconnect();
      const top = Array.from(changes.entries()).sort((a, b) => b[1] - a[1])[0];
      if (!top) return;
      send({
        type: 'mutation_snapshot',
        triggerSelector: selector(el),
        triggerLabel: label(el),
        maxChangedRegion: {
          selector: selector(top[0]),
          addedNodes: top[1],
          html: snap(top[0], 2000)
        }
      });
    }, 1000);
  }, true);

  let inputTimer = null;
  document.addEventListener('input', function(event) {
    const el = event.target;
    if (!el?.tagName?.match(/^(INPUT|TEXTAREA|SELECT)$/i)) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function() {
      const marker = [el.name, el.id, el.type].join(' ');
      const sensitive = /password|token|secret|key/i.test(marker);
      send({
        type: 'input',
        selector: selector(el),
        inputType: el.type || el.tagName.toLowerCase(),
        value: sensitive ? '***' : String(el.value || '').slice(0, 120)
      });
    }, 300);
  }, true);

  document.addEventListener('submit', function(event) {
    send({ type: 'submit', selector: selector(event.target) });
  }, true);

  document.addEventListener('keydown', function(event) {
    if (!['Enter', 'Escape', 'Tab'].includes(event.key)) return;
    send({ type: 'keydown', key: event.key, selector: selector(event.target) });
  }, true);

  let scrollTimer = null;
  document.addEventListener('scroll', function(event) {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      const target = event.target === document ? document.documentElement : event.target;
      send({
        type: 'scroll',
        selector: target === document.documentElement ? 'document' : selector(target),
        scrollTop: target.scrollTop || window.scrollY,
        scrollLeft: target.scrollLeft || window.scrollX
      });
    }, 300);
  }, true);
})();
`;

async function injectScripts() {
	if (!ws) return;
	await sendCmd(ws, "Runtime.evaluate", { expression: DOM_LISTENER_SCRIPT, awaitPromise: false }).catch(() => {});
	await sendCmd(ws, "Runtime.evaluate", { expression: STOP_BUTTON_SCRIPT, awaitPromise: false }).catch(() => {});
	await sendCmd(ws, "Runtime.evaluate", {
		expression: "document.title && !document.title.startsWith('[REC] ') ? document.title = '[REC] ' + document.title : document.title",
		awaitPromise: false,
	}).catch(() => {});
}

function parseBindingPayload(payload) {
	if (!payload) return null;
	try { return JSON.parse(payload); } catch {}
	return { value: String(payload) };
}

targetId = await openTab("about:blank");
await navigate(targetId, startUrl);
const tab = (await getTabs()).find((item) => item.id === targetId);
if (!tab) {
	await finish("tab-not-found", 1);
}

ws = await connectWs(tab.webSocketDebuggerUrl);
network = createNetworkObserver(ws, {
	withBody: true,
	onEvent: emit,
});

ws.addEventListener("message", ({ data }) => {
	let msg;
	try { msg = JSON.parse(data); } catch { return; }

	if (msg.method === "Runtime.bindingCalled") {
		const { name, payload } = msg.params;
		if (name === "__recordStop") {
			void finish(payload || "stop-button");
		} else if (name === "__recordEvent") {
			const event = parseBindingPayload(payload);
			if (event) emit(event);
		}
	}

	if (msg.method === "Page.frameNavigated" && msg.params.frame?.parentId == null) {
		const url = msg.params.frame.url;
		emit({ type: "navigate", url });
		if (endUrlPattern && url.includes(endUrlPattern)) void finish("end-url");
	}

	if (msg.method === "Page.loadEventFired" || msg.method === "Page.domContentEventFired") {
		void injectScripts();
	}
});

await sendCmd(ws, "Runtime.enable");
await sendCmd(ws, "Page.enable");
await network.enable();
await sendCmd(ws, "Runtime.addBinding", { name: "__recordEvent" });
await sendCmd(ws, "Runtime.addBinding", { name: "__recordStop" });
await sendCmd(ws, "Page.addScriptToEvaluateOnNewDocument", { source: DOM_LISTENER_SCRIPT });
await sendCmd(ws, "Page.addScriptToEvaluateOnNewDocument", { source: STOP_BUTTON_SCRIPT });
await injectScripts();

emit({ type: "meta", status: "start", startUrl, output: outputFile, targetId });
console.error(`recording: ${startUrl}`);
console.error(`output: ${outputFile}`);
console.error("click Stop & Save in the browser tab to finish");

timeoutHandle = setTimeout(() => { void finish("timeout"); }, timeoutMs);
