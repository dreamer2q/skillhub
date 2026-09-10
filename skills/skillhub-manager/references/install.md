# Obtain Skillhub

Requires Node.js 22+, Git and GitHub CLI. Repository access is required because the repository is private.

```bash
gh auth status
gh repo clone dreamer2q/skillhub
cd skillhub
npm install --global .
skillhub list --json
```

Alternatively, obtain a released npm tarball without configuring a package registry:

```bash
gh release download v0.1.0 --repo dreamer2q/skillhub --pattern '*.tgz' --dir /path/to/download
npm install --global /path/to/download/dreamer2q-skillhub-0.1.0.tgz
```

Use a fresh download directory and a pinned release version. Release assets include `SHA256SUMS` for integrity checking. Do not embed credentials in commands, repository URLs or documentation.

`npm install --global .` links a checkout on some npm versions; keep that checkout available. A tarball installation is independent of the source checkout. `node bin/skillhub.mjs` works directly in a checkout without npm installation.
