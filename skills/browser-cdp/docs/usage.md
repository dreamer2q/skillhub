# Browser CDP 用法

## 启动 Chrome

```bash
node scripts/cdp.mjs start --profile     # 默认，复用系统 Chrome 登录态
node scripts/cdp.mjs start --no-profile  # 匿名 profile
```

如果 `:9222` 已有可用 Chrome，脚本直接复用，不会重启或 `pkill`。

目标 CDP 地址可通过环境变量覆盖，默认是 `127.0.0.1:9222`：

```bash
CDP_HOST=127.0.0.1 CDP_PORT=9333 node scripts/cdp.mjs dump
```

`start` 只负责本机 Chrome 冷启动。`CDP_HOST` 指向非本机时，必须先在目标机器启动 Chrome CDP，本脚本只会探测并复用。
Linux root 环境会自动补 `--no-sandbox`；需要 headless 或额外启动参数时使用 `CHROME_FLAGS`：

```bash
CHROME_FLAGS="--headless=new" CDP_PORT=9333 node scripts/cdp.mjs start --no-profile
```

验证无 CDP 冷启动路径时，不要杀现有 `:9222` 登录态；使用临时端口和临时 profile：

```bash
CDP_PORT=9333 CHROME_USER_DATA_DIR=/tmp/browser-cdp-9333 node scripts/cdp.mjs start --no-profile
CDP_PORT=9333 node scripts/cdp.mjs nav 'data:text/html,<title>ColdStart</title><h1 id="app">ok</h1>' --new
CDP_PORT=9333 node scripts/cdp.mjs eval --url ColdStart "document.querySelector('#app').textContent"
```

## 导航

```bash
node scripts/cdp.mjs nav https://example.com
node scripts/cdp.mjs nav https://example.com --new
```

## 执行 JavaScript

```bash
node scripts/cdp.mjs eval --url <url-pattern> "document.title"
node scripts/cdp.mjs eval --url <url-pattern> "(() => { const n = document.querySelectorAll('a').length; return n })()"
```

`--url` 必填，匹配 tab URL 包含字符串。代码必须是单表达式或 IIFE。

## 截图

```bash
node scripts/cdp.mjs screenshot --url <url-pattern>
node scripts/cdp.mjs screenshot --url <url-pattern> --output /tmp/page.png
```

## Network 探测

```bash
node scripts/cdp.mjs sniff --url <url-pattern> --duration 30
node scripts/cdp.mjs sniff --url <url-pattern> --filter /api/ --with-body --with-response
node scripts/cdp.mjs sniff --url <url-pattern> --json > network.json
```

参数：

| 参数 | 说明 |
|---|---|
| `--url <pattern>` | 必填，目标 tab URL 关键词 |
| `--filter <keyword>` | URL 关键字过滤，可多次传入或逗号分隔 |
| `--duration <秒>` | 监听时长，默认 30 秒 |
| `--with-body` | 输出请求体 |
| `--with-response` | 输出响应体，适合短时间精准探测 |
| `--json` | 输出 JSON 数组 |

## 操作录制

```bash
node scripts/cdp.mjs record --url <start-url> --output /tmp/session.jsonl --timeout 300
node scripts/cdp.mjs record --url <start-url> --output /tmp/session.jsonl --observe-mutations
```

停止方式：

- 点击浏览器右下角 `Stop & Save`
- URL 命中 `--end-url`
- 超时
- `Ctrl+C`

输出 JSONL 示例：

```jsonl
{"t":1711900923000,"type":"meta","status":"start","startUrl":"https://example.com"}
{"t":1711900923456,"type":"click","selector":"#submit","label":"提交"}
{"t":1711900923512,"type":"network","method":"POST","url":"https://example.com/api/submit","status":200}
{"t":1711900925300,"type":"navigate","url":"https://example.com/result"}
{"t":1711900925400,"type":"meta","status":"done","endReason":"stop-button"}
```

解析：

```bash
node scripts/cdp.mjs parse /tmp/session.jsonl
node scripts/cdp.mjs parse /tmp/session.jsonl --api-only
node scripts/cdp.mjs parse /tmp/session.jsonl --json
```

默认输出目录是 `~/.cache/browser-cdp/record/`。

## 环境快照

```bash
node scripts/cdp.mjs dump
node scripts/cdp.mjs dump --json
```

用于排查浏览器未启动、tab 过多、内存异常或 CDP 无响应。

## 注意事项

- 所有脚本零 npm 依赖，只要求 Node 22+。
- `scripts/commands/` 是实现层；`scripts/*.js` / 旧 `scripts/*.mjs` 单功能入口只做兼容转发。
- `scripts/lib/cdp.mjs` 只放 CDP HTTP/WS、tab、Runtime、Page 基础封装；Network 监听统一走 `scripts/lib/network.mjs`。
- 脚本内部会自动给 CDP host 和本地地址补 `NO_PROXY` / `no_proxy`，调用方不要手写 `NO_PROXY=... node ...` 字符串命令。
- 录制要放在持久 PTY/session 中；一次性后台进程可能被宿主清理。
