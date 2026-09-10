#!/usr/bin/env node
/**
 * commands/parse-record.mjs
 * 解析 record.mjs 录制产出的 JSONL 文件，提取 API 请求、导航、点击事件
 *
 * 用法：
 *   node parse-record.mjs <input.jsonl> [--api-only] [--method GET|POST] [--filter <keyword>]
 *
 * 选项：
 *   --api-only       只输出包含 /api/ 的请求
 *   --method <M>     过滤请求方法（GET/POST/PUT 等）
 *   --filter <kw>    URL 关键字过滤（支持多个，逗号分隔）
 *   --full           输出完整 URL（默认截断 query string）
 *   --json           输出 JSON 数组（默认人类可读格式）
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const apiOnly = args.includes('--api-only');
const fullUrl = args.includes('--full');
const jsonOut = args.includes('--json');
const methodFilter = (() => { const i = args.indexOf('--method'); return i >= 0 ? args[i+1]?.toUpperCase() : null; })();
const filterKw = (() => { const i = args.indexOf('--filter'); return i >= 0 ? args[i+1]?.split(',') : null; })();

if (!inputFile) {
  console.error('用法: node parse-record.mjs <input.jsonl> [--api-only] [--method GET] [--filter keyword] [--full] [--json]');
  process.exit(1);
}

const results = [];

const rl = createInterface({ input: createReadStream(inputFile) });

for await (const line of rl) {
  if (!line.trim()) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }

  const type = ev.type;

  if (type === 'network') {
    const url = ev.url || '';
    if (apiOnly && !url.includes('/api/')) continue;
    if (methodFilter && ev.method?.toUpperCase() !== methodFilter) continue;
    if (filterKw && !filterKw.some(kw => url.includes(kw))) continue;
    results.push({
      type: 'network',
      method: ev.method || '?',
      url: fullUrl ? url : url.split('?')[0],
      query: fullUrl ? undefined : (url.includes('?') ? url.slice(url.indexOf('?')) : undefined),
      status: ev.status,
      ts: ev.ts,
    });
  } else if (type === 'navigate') {
    if (!apiOnly) results.push({ type: 'navigate', url: ev.url, ts: ev.ts });
  } else if (type === 'click') {
    if (!apiOnly && ev.label) results.push({ type: 'click', label: ev.label, selector: ev.selector, domSnapshot: ev.domSnapshot, ts: ev.ts });
  } else if (type === 'mutation_snapshot') {
    if (!apiOnly) results.push({ type: 'mutation_snapshot', triggerLabel: ev.triggerLabel, triggerSelector: ev.triggerSelector, maxChangedRegion: ev.maxChangedRegion, ts: ev.ts });
  } else if (type === 'scroll') {
    if (!apiOnly) results.push({ type: 'scroll', selector: ev.selector, scrollTop: ev.scrollTop, ts: ev.ts });
  } else if (type === 'clipboard') {
    if (!apiOnly) results.push({ type: 'clipboard', action: ev.action, text: ev.text, ts: ev.ts });
  }
}

if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (r.type === 'network') {
      const q = r.query ? ` \x1b[2m${r.query}\x1b[0m` : '';
      console.log(`\x1b[33m${r.method}\x1b[0m ${r.url}${q} \x1b[2m[${r.status ?? '?'}]\x1b[0m`);
    } else if (r.type === 'navigate') {
      console.log(`\x1b[36m[nav]\x1b[0m ${r.url}`);
    } else if (r.type === 'click') {
      console.log(`\x1b[35m[click]\x1b[0m ${r.label} \x1b[2m(${r.selector})\x1b[0m`);
      if (r.domSnapshot?.dataRegion) {
        // 只输出标签结构，不输出内容，方便推断 selector
        const tags = r.domSnapshot.dataRegion.match(/<[a-z][a-z0-9]*[\s>]/gi) || [];
        const uniq = [...new Set(tags.map(t => t.replace(/[\s>]/,'').toLowerCase()))].slice(0,8);
        console.log(`  \x1b[2m└ 数据区标签: ${uniq.join(', ')}\x1b[0m`);
      }
    } else if (r.type === 'clipboard') {
      console.log(`\x1b[33m[${r.action}]\x1b[0m ${r.text ? `"${r.text}"` : '(empty)'}`);
    } else if (r.type === 'scroll') {
      console.log(`\x1b[2m[scroll]\x1b[0m ${r.selector} scrollTop=${r.scrollTop}`);
    } else if (r.type === 'mutation_snapshot') {
      const region = r.maxChangedRegion;
      console.log(`\x1b[36m[mutation]\x1b[0m 点击「${r.triggerLabel}」后变化最大区域:`);
      console.log(`  \x1b[33m selector:\x1b[0m ${region?.selector}`);
      console.log(`  \x1b[33m 变化量:\x1b[0m  ${region?.addedNodes} 节点`);
      if (region?.html) {
        const tags = region.html.match(/<[a-z][a-z0-9]*[\s>]/gi) || [];
        const uniq = [...new Set(tags.map(t => t.replace(/[\s>]/,'').toLowerCase()))].slice(0,10);
        console.log(`  \x1b[2m└ 标签结构: ${uniq.join(', ')}\x1b[0m`);
      }
    }
  }
  console.error(`\n共 ${results.length} 条记录`);
}
