# 技能创作与目录协议

`catalog.json` 是 schemaVersion 1 的唯一目录源；npm 版本用于分发快照，每个 skill 另有独立的 `major.minor.patch` 版本。不支持版本范围和跨目录依赖解析：一个快照中的技能依赖同一个快照，便于复现。

```json
{
  "version": "0.1.0",
  "description": "具体能力与触发场景",
  "path": "skills/my-skill",
  "tags": ["automation"],
  "dependencies": ["browser-cdp"]
}
```

将其放在 `skills.my-skill` 下。名称使用小写字母、数字和单连字符，最多 63 字符。`SKILL.md` 顶部必须有 YAML frontmatter，`name` 使用未加引号的同名字符串，`description` 使用非空单行文本（可加引号）；其他元信息可保留。校验器只验证这个受限格式，不是完整 YAML 解析器。

1. `node bin/skillhub.mjs create my-skill --description "具体能力" --source .` 创建骨架。
2. 编辑 `skills/my-skill/SKILL.md`，替换示例指导；按实际需求添加 scripts、references、assets 或 agents 元信息。
3. 在 `catalog.json` 声明依赖；依赖按拓扑顺序安装，循环/缺失依赖会被拒绝。
4. `collections` 将名字映射到技能名数组，如 `"web": ["browser-cdp", "my-skill"]`。
5. `targets` 增加适配器，如 `"other": { "global": "~/.other/skills", "project": ".other/skills" }`；也可不改目录，安装时传 `--dir`。
6. `npm run check`，再安装到临时目录进行实际使用验证。静态语法通过不等于技能业务行为正确。
7. 修改已有技能后 `bump <name> patch --source .`（功能增加用 minor，不兼容变更用 major），更新 CHANGELOG，提交评审。

导入其他目录中的 skill 时，先复制到 `skills/<name>` 并补充目录项；检查脚本相对引用、来源/授权、登录态和运行产物。不要复制旧注册中心的签名，它不再对应当前内容。首版不提供执行任意远程仓库代码的自动导入钩子。

`--source /path/to/another/catalog` 可以使用另一个遵守此协议的本地目录。CLI 不存储 GitHub 凭据，远端更新交给 gh/git/npm；这样私有源的认证与技能安装保持独立。

目录名 `name` 是安装状态的来源标识，发布后应保持稳定。同名 skill 属于其他来源时不会被接管。创作命令要求显式 `--source`，且应串行运行在可写 Git checkout 中。

增加目标只支持目录适配。需要插件清单、客户端注册或专有格式转换的 Agent，应先增加明确的适配实现和测试，不能仅凭成功复制目录就声称兼容。
