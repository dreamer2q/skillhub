#!/usr/bin/env node
/**
 * commands/dump-env.mjs — 浏览器环境信息快照
 *
 * 输出当前浏览器的完整状态，用于问题定位：
 *   - 浏览器版本 & 进程信息
 *   - 所有 Tab 列表（id / url / title / 类型）
 *   - 每个 Tab 的内存占用（JS Heap）
 *   - 系统内存概况（performance.memory）
 *
 * 用法：
 *   node scripts/dump_env.mjs [--json]
 *
 * 选项：
 *   --json    输出原始 JSON（默认输出可读格式）
 *
 * 示例：
 *   node scripts/dump_env.mjs
 *   node scripts/dump_env.mjs --json > env-snapshot.json
 */

import http from 'node:http';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CDP_HOST, CDP_PORT, connectWs, sendCmd } from '../lib/cdp.mjs';

const JSON_MODE = process.argv.includes('--json');

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}\nRaw: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function fmt(bytes) {
  if (bytes == null) return 'N/A';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ─── 采集数据 ──────────────────────────────────────────────────────────────────

// 1. /json/version — 浏览器版本信息
const version = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`).catch(() => null);

// 2. /json — 所有 target 列表
const targets = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`).catch(e => {
  console.error(`✗ Cannot connect to Chrome at ${CDP_HOST}:${CDP_PORT} — ${e.message}`);
  process.exit(1);
});

// 3. 每个 page tab 的 JS Heap 信息（via CDP Performance domain）
// Performance.getMetrics 需要先 enable，用独立函数发两条命令
function getTabMetrics(wsUrl) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => {
      try { if (ws) ws.close(); } catch {}
      resolve([]);
    }, 5000);

    connectWs(wsUrl)
      .then(async (connectedWs) => {
        ws = connectedWs;
        await sendCmd(ws, 'Performance.enable', {});
        const result = await sendCmd(ws, 'Performance.getMetrics', {});
        clearTimeout(timer);
        ws.close();
        resolve(result?.metrics ?? []);
      })
      .catch(() => {
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch {}
        resolve([]);
      });
  });
}

const tabs = targets.filter(t => t.type === 'page');
const tabDetails = await Promise.all(tabs.map(async (tab) => {
  const memMetrics = await getTabMetrics(tab.webSocketDebuggerUrl).catch(() => []);
  const jsHeapUsed = memMetrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? null;
  const jsHeapTotal = memMetrics.find(m => m.name === 'JSHeapTotalSize')?.value ?? null;
  const layoutCount = memMetrics.find(m => m.name === 'LayoutCount')?.value ?? null;
  const scriptDuration = memMetrics.find(m => m.name === 'ScriptDuration')?.value ?? null;
  return {
    id: tab.id,
    title: tab.title || '(no title)',
    url: tab.url,
    jsHeapUsed,
    jsHeapTotal,
    layoutCount,
    scriptDuration,
  };
}));

// 4. 系统内存
const systemMem = {
  total: os.totalmem(),
  free: os.freemem(),
  used: os.totalmem() - os.freemem(),
};

// 5. Chrome 进程内存（Linux 优先从 /proc 读）
// 通过 --remote-debugging-port 参数精准定位主进程
let chromeProc = null;
try {
  const psCommand = process.platform === 'darwin'
    ? `ps aux | grep 'remote-debugging-port=${CDP_PORT}' | grep -v grep | head -1`
    : `ps aux --no-header | grep 'remote-debugging-port=${CDP_PORT}' | grep -v grep | head -1`;
  const ps = execSync(
    psCommand,
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  if (ps) {
    const parts = ps.split(/\s+/);
    const pid = parts[1];
    const rssKb = parseInt(parts[5]);
    // 从 /proc/<pid>/status 读 VmRSS 更准确
    let rssReal = rssKb;
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const vmRss = status.match(/VmRSS:\s+(\d+)/);
      if (vmRss) rssReal = parseInt(vmRss[1]);
    } catch { /* fallback to ps value */ }
    chromeProc = { pid, cpu: parts[2] + '%', mem: parts[3] + '%', rss: fmt(rssReal * 1024) };
  }
} catch { /* ignore */ }

// 6. 所有 target 分类统计
const targetSummary = targets.reduce((acc, t) => {
  acc[t.type] = (acc[t.type] || 0) + 1;
  return acc;
}, {});

// ─── 组装结果 ──────────────────────────────────────────────────────────────────
const snapshot = {
  timestamp: new Date().toISOString(),
  browser: {
    browser: version?.Browser ?? 'unknown',
    protocolVersion: version?.['Protocol-Version'] ?? 'unknown',
    userAgent: version?.['User-Agent'] ?? 'unknown',
    v8Version: version?.['V8-Version'] ?? 'unknown',
    wsDebuggerUrl: version?.webSocketDebuggerUrl ?? 'unknown',
  },
  targets: {
    total: targets.length,
    byType: targetSummary,
  },
  tabs: tabDetails,
  system: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpus: os.cpus().length,
    memory: systemMem,
    chromeProcess: chromeProc,
  },
};

// ─── 输出 ──────────────────────────────────────────────────────────────────────
if (JSON_MODE) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

// 可读格式
const ts = new Date(snapshot.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
console.log(`\n╔══ Browser CDP 环境快照  ${ts} ══╗\n`);

console.log('▌ 浏览器');
console.log(`  版本:      ${snapshot.browser.browser}`);
console.log(`  V8:        ${snapshot.browser.v8Version}`);
console.log(`  CDP 协议:  ${snapshot.browser.protocolVersion}`);

console.log('\n▌ Target 统计');
console.log(`  总计: ${snapshot.targets.total}`);
for (const [type, count] of Object.entries(snapshot.targets.byType)) {
  console.log(`  ${type.padEnd(12)} × ${count}`);
}

console.log(`\n▌ Tab 列表（共 ${tabDetails.length} 个页面）`);
tabDetails.forEach((tab, i) => {
  const heap = tab.jsHeapUsed != null
    ? `${fmt(tab.jsHeapUsed)} / ${fmt(tab.jsHeapTotal)}`
    : 'N/A';
  console.log(`  [${i + 1}] ${tab.title.substring(0, 40).padEnd(40)}  Heap: ${heap}`);
  console.log(`      ${tab.url.substring(0, 80)}`);
  if (tab.layoutCount != null) {
    console.log(`      Layout: ${tab.layoutCount}  ScriptTime: ${tab.scriptDuration?.toFixed(3)}s`);
  }
});

console.log('\n▌ 系统内存');
console.log(`  总内存:  ${fmt(systemMem.total)}`);
console.log(`  已使用:  ${fmt(systemMem.used)}  (${(systemMem.used / systemMem.total * 100).toFixed(1)}%)`);
console.log(`  空闲:    ${fmt(systemMem.free)}`);

if (chromeProc) {
  console.log('\n▌ Chrome 主进程');
  console.log(`  PID: ${chromeProc.pid}  CPU: ${chromeProc.cpu}  MEM: ${chromeProc.mem}  RSS: ${chromeProc.rss}`);
}

console.log('\n' + '─'.repeat(60));
console.log('提示：加 --json 输出原始 JSON，可用于自动化分析');
console.log();
