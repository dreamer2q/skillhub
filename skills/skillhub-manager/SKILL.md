---
name: skillhub-manager
description: "Use Skillhub to discover, install, update, remove or author skills for Codex, Claude Code and compatible agents. Use when the user asks to manage a Skillhub catalog or its installed skills."
---

# Skillhub Manager

Use the `skillhub` CLI. If unavailable, follow [installation](references/install.md) to obtain it from the private GitHub repository with the user's existing GitHub authentication.

## Discover and install

1. Run `skillhub list --json` and `skillhub targets --json` to find exact names and target adapters.
2. Read `skillhub info <name> --json` before installing a new skill; installing instructions does not authorize executing the workflows inside them.
3. Choose the requested agent and scope. Use `--agent codex|claude|agents`, `--scope global|project`, or `--dir <skills-directory>` for another agent. Project scope is relative to the current working directory.
4. Preview `skillhub install <name> --agent <agent> --dry-run --json`, then run the same command without `--dry-run` within the user's requested scope.
5. Run `skillhub doctor --agent <agent> --json` using the same destination options. This checks file integrity, not whether a running agent has loaded the skill; restart its session when needed and verify discovery there.

## Update and remove

`skillhub installed --json` shows managed versions and local edits. `update` uses the CLI's bundled snapshot, or an explicit `--source <catalog-directory>`; it does not fetch the network. Upgrade the CLI or pull the catalog before requesting newer content.

Use `skillhub update [names...]` or `skillhub remove <names...>` with matching destination flags. Do not automatically add `--force` after a conflict. Inspect local edits first; when replacement is intended, `--force` retains the previous files in the returned backup directory. Unmanaged installations must be explicitly moved aside before adoption. Dependency removal requires removing dependents together.

If a lock or interrupted transaction is reported, stop writes, check whether another CLI process is active, and inspect the paths returned by `doctor`. See the repository's `docs/recovery.md` before restoring files; do not delete recovery material blindly.

## Author and iterate

Work in a Git checkout; never modify the installed npm package. Run:

```bash
skillhub create my-skill --description "Specific capability and when to use it" --source /path/to/skillhub
skillhub validate --source /path/to/skillhub
skillhub bump my-skill patch --source /path/to/skillhub
```

Replace scaffold prose with a concrete workflow. Add scripts/references only when useful. Declare same-catalog dependencies and collections in `catalog.json`; test installation into a temporary directory and exercise any added script. Check `AGENTS.md` and `docs/authoring.md` in the checkout for maintenance and release conventions.

Return changed skills, destination, version and verification results. Publishing a package is a separate operation from local authoring or installation.
