#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertName, loadCatalog, readJSON, resolveSkills, validate, VERSION, writeJSON } from '../lib/catalog.mjs';
import { applyChanges, doctor, installed, planChanges, targetPath } from '../lib/install.mjs';

const bundledRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `skillhub — portable skill lifecycle (Node >=22)

  list [query]                    List/search catalog skills
  info <name>                     Show skill metadata and instructions
  targets                         List agent destinations
  install <names...>               Install skills and dependencies
  install --collection starter    Install a curated collection
  update [names...]               Update managed skills from selected catalog
  remove <names...>               Remove managed skills (protects dependencies)
  installed                      Show managed versions and local changes
  doctor                         Check installed integrity and interrupted operations
  validate                       Validate catalog, skills and script syntax
  create <name> --description ... Scaffold and register a skill
  bump <name> <patch|minor|major> Increment a skill version

Options:
  --agent codex|claude|agents      Destination adapter (default: codex)
  --scope global|project          Installation scope (default: global)
  --dir <directory>               Explicit skills destination for any agent
  --source <catalog-directory>    Catalog source (default: bundled with CLI)
  --collection <name>             Named collection, install only
  --all                          All catalog skills, install only
  --dry-run                      Plan install/update/remove without writes
  --force                        Replace modified MANAGED skills, retain backup
  --allow-downgrade               Allow installing an older catalog version
  --json                         Structured stdout, including errors
  --help, --version

Update uses the selected catalog snapshot; upgrade the CLI or git pull first.
Existing unmanaged skills are never overwritten. No skill scripts run on install.
`;
function parse(argv) {
  const options = {}, words = [];
  const flags = new Set(['json', 'dry-run', 'force', 'all', 'allow-downgrade', 'help', 'version']);
  const values = new Set(['agent', 'scope', 'dir', 'source', 'collection', 'description']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
      options[key] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { options, words };
}
function emit(value, options) {
  if (options.json) console.log(JSON.stringify({ ok: true, data: value }, null, 2));
  else if (Array.isArray(value)) for (const row of value) console.log(typeof row === 'string' ? row : JSON.stringify(row));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
try {
  const { options, words } = parse(process.argv.slice(2));
  const [command, ...names] = words;
  if (options.version) { emit(readJSON(path.join(bundledRoot, 'package.json')).version, options); }
  else if (!command || options.help) { emit(usage, options); }
  else {
    const commands = ['list', 'info', 'targets', 'install', 'update', 'remove', 'installed', 'doctor', 'validate', 'create', 'bump'];
    if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);
    if ((options.collection || options.all) && command !== 'install') throw new Error('--collection/--all are install-only');
    if (options['dry-run'] && !['install', 'update', 'remove'].includes(command)) throw new Error('--dry-run is for install/update/remove');
    if (['create', 'bump'].includes(command) && !options.source) throw new Error('Authoring requires --source <working-repository>, never edits an installed npm package implicitly');
    const root = path.resolve(options.source || bundledRoot);
    const catalog = loadCatalog(root);
    const target = targetPath(catalog, options);
    let result;
    switch (command) {
      case 'list': {
        const query = names.join(' ').toLowerCase();
        result = Object.entries(catalog.skills).map(([name, s]) => ({ name, ...s })).filter(s => JSON.stringify(s).toLowerCase().includes(query));
        break;
      }
      case 'info': {
        if (names.length !== 1 || !Object.hasOwn(catalog.skills, names[0])) throw new Error('info needs one known skill');
        const skill = catalog.skills[names[0]];
        result = { name: names[0], ...skill, instructions: fs.readFileSync(path.join(root, skill.path, 'SKILL.md'), 'utf8') }; break;
      }
      case 'targets': result = catalog.targets; break;
      case 'installed': result = installed(target); break;
      case 'doctor': result = doctor(target); if (!result.ok) process.exitCode = 1; break;
      case 'validate': {
        result = validate(root, catalog);
        const { filesIn } = await import('../lib/catalog.mjs');
        for (const skill of Object.values(catalog.skills)) for (const file of filesIn(path.join(root, skill.path))) {
          if (!/\.(mjs|cjs|js)$/.test(file)) continue;
          const check = spawnSync(process.execPath, ['--check', path.join(root, skill.path, file)], { encoding: 'utf8' });
          if (check.status !== 0) throw new Error(`Syntax check failed: ${skill.path}/${file}\n${check.stderr}`);
        }
        break;
      }
      case 'install': case 'update': case 'remove': {
        let selection = names;
        if (command === 'install') {
          if (options.collection) {
            if (!Object.hasOwn(catalog.collections, options.collection)) throw new Error(`Unknown collection: ${options.collection}`);
            selection = [...selection, ...catalog.collections[options.collection]];
          }
          if (options.all) selection = Object.keys(catalog.skills);
        }
        if (command === 'update') {
          const current = installed(target).filter(s => s.source === catalog.name);
          if (!selection.length) selection = current.map(s => s.name);
          if (selection.some(n => !current.some(s => s.name === n))) throw new Error('update requires skills already managed by this catalog');
        }
        if (!selection.length) {
          if (command === 'update') { result = { target, changes: [] }; break; }
          throw new Error(`${command} needs a skill name or collection`);
        }
        if (command !== 'remove') { validate(root, catalog); selection = resolveSkills(catalog, selection); }
        const args = { root, catalog, target, names: [...new Set(selection)], remove: command === 'remove', force: options.force, allowDowngrade: options['allow-downgrade'] };
        result = options['dry-run'] ? planChanges(args) : applyChanges(args);
        break;
      }
      case 'create': {
        if (names.length !== 1 || !options.description?.trim()) throw new Error('create needs <name> --description <purpose>');
        const name = names[0]; assertName(name);
        if (Object.hasOwn(catalog.skills, name)) throw new Error(`Skill exists: ${name}`);
        const dir = path.join(root, 'skills', name);
        fs.mkdirSync(dir); // Refuse existing content, including unregistered skills.
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(options.description)}\n---\n\n# ${name}\n\n${options.description}\n\nDescribe the concrete workflow, relevant inputs and how to verify the result.\n`);
        catalog.skills[name] = { version: '0.1.0', description: options.description, path: `skills/${name}`, tags: [], dependencies: [] };
        writeJSON(path.join(root, 'catalog.json'), catalog);
        result = { name, path: dir, next: 'Replace scaffold guidance with the real workflow, then validate and test.' }; break;
      }
      case 'bump': {
        if (names.length !== 2 || !Object.hasOwn(catalog.skills, names[0]) || !['patch', 'minor', 'major'].includes(names[1])) throw new Error('bump needs <known-skill> <patch|minor|major>');
        const skill = catalog.skills[names[0]];
        if (!VERSION.test(skill.version)) throw new Error('Invalid version');
        const parts = skill.version.split('.').map(Number), index = { major: 0, minor: 1, patch: 2 }[names[1]];
        parts[index]++; for (let i = index + 1; i < 3; i++) parts[i] = 0;
        skill.version = parts.join('.'); writeJSON(path.join(root, 'catalog.json'), catalog);
        result = { name: names[0], version: skill.version }; break;
      }
    }
    emit(result, options);
  }
} catch (error) {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.message }));
  else console.error(`skillhub: ${error.message}`);
  process.exitCode = 1;
}
