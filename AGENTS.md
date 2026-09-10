# Skillhub maintenance

- This repository owns the CLI and the versioned skill sources under `skills/`. Never edit copies in an agent's home directory as the source of truth.
- Read `README.md` for commands, `docs/authoring.md` for catalog contracts and `docs/releasing.md` for distribution.
- Keep the Node.js CLI dependency-free at runtime. Add target directory adapters in `catalog.json`; do not fork skill content per agent without an actual compatibility requirement.
- Preserve unrelated work. Check `git status --short --branch` before editing.
- Bump a changed skill's version in `catalog.json`; bump the npm package version for a release. Document user-visible changes in `CHANGELOG.md`.
- Validate with `npm run check` and `npm pack --dry-run`. Installation tests use temporary directories; do not modify the maintainer's real agent skills or launch a browser during tests.
- Never commit browser profiles, recordings, credentials or copied distribution signatures. Metadata validation and credential-pattern checks are limited guards, not an exhaustive secret audit.
- Installer changes need behavioral tests for conflicts, dependencies and recovery. Keep unmanaged installations protected; do not silently force an update.
- Changes to browser-cdp scripts should preserve its zero-dependency command contracts and avoid interfering with an existing logged-in browser.
- Do not publish to a public registry or change repository visibility as a side effect of maintenance. The configured npm registry is private GitHub Packages; package publishing is an explicit release action.
