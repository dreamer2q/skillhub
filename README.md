# Skillhub

维护、组合和分发 Agent Skills 的私有 Git 仓库，同时提供零运行时依赖的 Node.js CLI。技能源码是普通 `SKILL.md` 目录，可用于 Codex、Claude Code 及其他兼容 Agent。

## 安装与使用

需要 Node.js 22+；访问私有 GitHub 仓库需要 GitHub CLI 登录态。

```bash
gh repo clone dreamer2q/skillhub
cd skillhub
node bin/skillhub.mjs list
node bin/skillhub.mjs install browser-cdp --agent codex --dry-run
node bin/skillhub.mjs install browser-cdp --agent codex
node bin/skillhub.mjs install --collection starter --agent claude
```

可用 `npm install --global .` 注册 `skillhub` 命令。也可使用不依赖源码 checkout 的 npm 压缩包：

```bash
gh release download v0.1.0 --repo dreamer2q/skillhub --pattern '*.tgz' --pattern SHA256SUMS --dir ./release-download
cd release-download
shasum -a 256 -c SHA256SUMS
npm install --global ./dreamer2q-skillhub-0.1.0.tgz
skillhub list --json
```

不要把 Token 放进 Git URL。GitHub Packages 是另一个可选分发渠道，见 [发布说明](docs/releasing.md)。

## 常用命令

| 命令 | 行为 |
| --- | --- |
| `list [query]` / `info <name>` | 搜索目录 / 读取元信息和指令 |
| `install <names...>` | 安装技能及其依赖 |
| `install --collection starter` / `install --all` | 安装组合包 / 全目录 |
| `installed` / `doctor` | 已安装版本、修改状态 / 完整性及恢复检查 |
| `update [names...]` | 从当前 CLI 自带目录或 `--source` 更新已管理技能 |
| `remove <names...>` | 卸载已管理技能，检查依赖关系 |
| `targets` | 列出目标 Agent 适配配置 |
| `create <name> --description "..." --source .` | 创建并注册新技能 |
| `bump <name> patch --source .` | 增加技能版本，也支持 minor/major |
| `validate` | 检查目录、元信息、常见敏感产物和脚本语法 |

安装、更新、卸载支持 `--dry-run`；所有命令支持 `--json`。失败退出码为 1，JSON 错误为 `{ "ok": false, "error": "..." }`；成功返回 `{ "ok": true, "data": ... }`。`doctor` 的诊断结果在 `data.ok` 中，不健康时退出码也是 1。

`update` 不会联网拉取最新代码：先 `git pull --ff-only` 或安装新版 CLI，再执行更新。可通过旧版本 npm 压缩包配合 `--allow-downgrade` 回退技能版本。

## 安装位置

| `--agent` | 全局（默认） | `--scope project` |
| --- | --- | --- |
| `codex` | `$CODEX_HOME/skills` 或 `~/.codex/skills` | 当前目录 `.agents/skills` |
| `claude` | `$CLAUDE_CONFIG_DIR/skills` 或 `~/.claude/skills` | 当前目录 `.claude/skills` |
| `agents` | `~/.agents/skills` | 当前目录 `.agents/skills` |

Codex 默认保留已有 `.codex/skills` 工作流；需要共享 Agent Skills 目录时选 `--agent agents`。显式 `--dir /path/to/skills` 可适配其他 Agent，并覆盖内置路径。目录规则集中在 `catalog.json`，增加 Agent 不需要改安装器。参考 [Claude Code skills](https://code.claude.com/docs/en/skills) 与 [OpenAI skills catalog](https://github.com/openai/skills)。

安装是复制文件，不执行技能脚本、不启动浏览器。运行中的 Agent 是否自动重新发现技能取决于客户端；需要时重启会话并验证实际发现结果。

## 已收录

- **browser-cdp 1.0.0**：从本地 V36 导入的 Chrome CDP 工具；保留原脚本能力，移除内部账号元信息和内网示例。不会随包携带浏览器登录态。
- **skillhub-manager 1.0.0**：让 Agent 理解本仓库的安装、更新、检查和创作流程。

`browser` 组合包含 browser-cdp；`starter` 组合包含以上两个技能。

## 本地修改保护

未由 Skillhub 管理的同名目录不会覆盖，即使指定 `--force`。先比较旧目录与仓库内容，再自行备份/移走旧目录。不会自动接管当前机器已有的 browser-cdp。

已管理技能通过 SHA-256 检测内容和可执行位变化；有本地修改时拒绝更新/卸载。明确需要替换时用 `--force`，原文件保留在返回的备份目录。安装前先检查整个批次，运行错误会回滚已应用的文件替换；进程强制退出的恢复方式见 [恢复说明](docs/recovery.md)。

## 维护与扩展

```bash
npm run check
npm pack --dry-run
skillhub create my-skill --description "何时使用、提供什么能力" --source .
skillhub bump my-skill patch --source .
```

- [创作与目录协议](docs/authoring.md)：技能、依赖、组合和 Agent 适配。
- [发布与安装](docs/releasing.md)：GitHub Release / GitHub Packages。
- [Agent 维护约定](AGENTS.md)：验证、版本及源码边界。
- [导入来源](NOTICE.md)：browser-cdp 的来源和版本对应。

本仓库及包默认按私有方式维护，未授予开源许可。凭据模式扫描不是完整安全审计；browser-cdp 的运行产物可能包含敏感数据，详见其 `SKILL.md`。
