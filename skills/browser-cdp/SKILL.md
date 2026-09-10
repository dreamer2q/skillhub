---
name: browser-cdp
description: "基于 Chrome DevTools Protocol 的零依赖浏览器自动化工具。触发场景：复用本机 Chrome 登录态、打开/导航网页、在指定 tab 执行 JS、截图、监听 Network、录制用户操作、API 探测、表单自动化、内网页面数据采集。其他依赖浏览器登录态的 skill 应优先依赖本 skill。"

---

# Browser CDP

基于 Chrome DevTools Protocol 操作 Chrome，默认连接 `127.0.0.1:9222`。所有脚本只依赖 Node 22+ 内置能力，不需要 `npm install`，不允许引入外部 npm 包。

## 适用边界

- 适用：复用已登录 Chrome profile、指定 tab 执行 JS、导航、截图、监听 XHR/fetch、录制真实用户操作。
- 不适用：需要 Playwright/Selenium 完整浏览器框架、无头批量爬虫、绕过登录鉴权。
- 内网页面默认复用本机登录态；不要把 cookie/header/token 写进公开文档。

## 基本流程

```bash
SKILL_DIR=<browser-cdp skill directory>
SCRIPTS="$SKILL_DIR/scripts"
BROWSER_CDP="$SCRIPTS/cdp.mjs"

"$BROWSER_CDP" start --profile
"$BROWSER_CDP" nav https://example.com --new
"$BROWSER_CDP" eval --url example.com "document.title"
"$BROWSER_CDP" screenshot --url example.com
```

脚本内部会自动给 `CDP_HOST` / `127.0.0.1` / `localhost` / `::1` 补 `NO_PROXY` 和 `no_proxy`，调用方不要把 `NO_PROXY=... node ...` 包进字符串变量。

`--url` 是 tab URL 包含匹配，不是完整正则。多 tab 并存时必须显式传 `--url`。
冷启动验证不要 kill 现有 `:9222` 登录态，可用临时端口：

```bash
CDP_PORT=9333 CHROME_USER_DATA_DIR=/tmp/browser-cdp-9333 \
  node "$SCRIPTS/cdp.mjs" start --no-profile
```

`CDP_HOST` / `CDP_PORT` 可覆盖目标 CDP 地址；未设置时兜底到 `127.0.0.1:9222`。`start` 只负责本机 Chrome 冷启动；当 `CDP_HOST` 指向非本机时，只能复用已存在的远端 CDP。
Linux 环境若需要额外 Chrome 参数，可通过 `CHROME_FLAGS` 追加；root 启动时脚本会自动补 `--no-sandbox`。

## 工具速查

| 入口 | 用途 | 依赖 |
|---|---|---|
| `scripts/cdp.mjs` | 统一入口：`start/nav/eval/screenshot/sniff/record/parse/dump` | Node 内置 |
| `scripts/start.js` | 兼容 shim，转发到 `scripts/cdp.mjs start` | Node 内置 |
| `scripts/nav.js` | 兼容 shim，转发到 `scripts/cdp.mjs nav` | Node 内置 |
| `scripts/eval.js` | 兼容 shim，转发到 `scripts/cdp.mjs eval` | Node 内置 |
| `scripts/screenshot.js` | 兼容 shim，转发到 `scripts/cdp.mjs screenshot` | Node 内置 |
| `scripts/sniff_network.mjs` | 兼容 shim，转发到 `scripts/cdp.mjs sniff` | Node 内置 |
| `scripts/record.mjs` | 兼容 shim，转发到 `scripts/cdp.mjs record` | Node 内置 |
| `scripts/parse-record.mjs` | 兼容 shim，转发到 `scripts/cdp.mjs parse` | Node 内置 |
| `scripts/dump_env.mjs` | 兼容 shim，转发到 `scripts/cdp.mjs dump` | Node 内置 |

实现层在 `scripts/commands/`；CDP 基础封装在 `scripts/lib/cdp.mjs`，Network 监听复用 `scripts/lib/network.mjs`，参数解析复用 `scripts/lib/args.mjs`。

## JavaScript 执行规则

`eval.js` 的 code 必须是单个表达式或 IIFE：

```bash
node "$SCRIPTS/eval.js" --url example.com "document.title"
node "$SCRIPTS/eval.js" --url example.com "(() => { const x = 1; return x + 1 })()"
```

不要传多条顶层语句：

```bash
node "$SCRIPTS/eval.js" --url example.com "const x = 1; return x"
```

传中文/多字节 payload 时，页面里解码 base64 必须用 `TextDecoder('utf-8')`，不能用裸 `atob`。`atob` 只按 Latin-1 逐字节解码，UTF-8 多字节字符会乱码：

```bash
# 错误：atob 不还原 UTF-8，中文变乱码
node "$SCRIPTS/eval.js" --url example.com "atob('5Lit5paH')"

# 正确：先 atob 拿字节，再用 TextDecoder 按 UTF-8 还原
node "$SCRIPTS/eval.js" --url example.com \
  "new TextDecoder('utf-8').decode(Uint8Array.from(atob('5Lit5paH'), c => c.charCodeAt(0)))"
```

`eval.js` 超时或 tab 无响应时会打印 `Stop retrying`，遇到后停止重试并反馈现场。

## Network 探测

```bash
"$BROWSER_CDP" sniff --url example.com --filter /api/ --duration 60 --with-body --with-response
```

默认人类可读输出；需要结构化结果时加 `--json`。

`sniff` 只监听命令启动之后发生的请求，空输出只能说明监听窗口内没抓到，不能证明页面没有请求。排查 SPA 首屏接口时优先先监听再触发请求：

```bash
"$BROWSER_CDP" sniff --url example.com --filter /api/ --duration 20 --with-response --reload
```

如果页面已经加载完、sniff 错过了请求，用 `performance.getEntriesByType("resource")` 发现历史 URL，再用 `eval` 里的 `fetch(url, {credentials:"include"})` 复用登录态读取接口。不要把 sniff 空结果当作业务结论。

## 操作录制

长时间录制必须放在持久 PTY/session 中运行，等待用户在浏览器里点击 `Stop & Save`。

```bash
"$BROWSER_CDP" record \
  --url https://example.com \
  --timeout 300 \
  --output /tmp/session.jsonl \
  --observe-mutations
```

录制结束后解析：

```bash
"$BROWSER_CDP" parse /tmp/session.jsonl --api-only
"$BROWSER_CDP" parse /tmp/session.jsonl --json
```

## 验证

```bash
node bin/skillhub.mjs validate  # 在 skillhub 仓库根目录运行
find skills/browser-cdp/scripts -type f \( -name '*.mjs' -o -name '*.js' \) -print | sort | while read -r f; do node --check "$f" || exit 1; done
```

真实 CDP 回路用临时 `CDP_PORT` 验证冷启动，避免破坏现有 `:9222` 登录态。

## 数据处理

启动默认复制系统 Chrome 的 Cookies、Login Data 和 Web Data 到独立缓存目录；这些文件不属于 skill 包。`--no-profile` 只跳过同步，不会清空已有缓存，也不会替换已运行实例。需要隔离时使用全新目录及端口。

录制会保存请求体、页面片段和输入内容；sniff 可保存响应体。表单脱敏仅覆盖字段名匹配的部分情况，URL、请求体和响应体没有统一脱敏。分享产物前检查凭据、个人信息和业务数据。

## 维护规则

- 禁止引入 Puppeteer、Playwright、Selenium 等外部包依赖。
- 禁止出现 `package.json`、`package-lock.json`、`node_modules/`。
- 新脚本优先复用 `scripts/lib/cdp.mjs` / `scripts/lib/network.mjs`。
- 文档里出现的 `scripts/*` 必须真实存在。
- 对外优先暴露 `scripts/cdp.mjs`；单功能脚本只作为兼容入口保留。
- 依赖本 skill 的下游 skill 只应依赖命令契约，不复制 CDP 启动/登录细节。
