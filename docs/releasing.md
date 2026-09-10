# 发布与分发

## GitHub Release（默认，无 npm 账号要求）

```bash
npm run check
npm version patch --no-git-tag-version
# 更新 CHANGELOG，检查并提交变更
git add package.json package-lock.json CHANGELOG.md catalog.json skills bin lib docs
git commit -m "Release skillhub"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

`release.yml` 对 `v*` tag 验证包版本、运行检查，打包 `.tgz` 和 `SHA256SUMS` 并创建私有仓库的 GitHub Release。可使用 `gh release download` 下载后 `npm install --global ./<package>.tgz`；npm 包已经带齐技能目录，不依赖本地源码路径。

## GitHub Packages（可选，需显式触发）

仓库提供 `publish.yml`，通过 `workflow_dispatch` 选择已有 release tag，例如 `v0.1.0`。它再次验证测试，使用工作流 `GITHUB_TOKEN` 发布到 `https://npm.pkg.github.com`，不会发布到 npmjs.org。默认 GitHub Packages 新包为私有；发布后在包设置中核对可见性及继承的访问权限。[GitHub npm registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)

```bash
gh workflow run publish.yml --repo dreamer2q/skillhub -f tag=v0.1.0
```

从 GitHub Packages 安装需要该包的读取权限。按 GitHub 文档通过交互登录配置 registry：

```bash
npm login --scope=@dreamer2q --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @dreamer2q/skillhub@0.1.0 --registry=https://npm.pkg.github.com
```

发布同一版本不能覆盖；变更需要新版本。GitHub Release 已创建不代表 GitHub Packages 已发布，两条渠道独立。首次发布需要仓库 Actions 允许 packages:write；本地不需要配置写入 Token。

## 未来 npmjs.org

当前 `publishConfig` 固定指向 GitHub Packages，避免将私有内容意外发布到公共 registry。将来决定公开后，再核对许可、包名/scope 所有权和内容，修改 registry，配置 npm trusted publishing 并增加对应 workflow。当前不自动执行该步骤。
