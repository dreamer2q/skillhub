import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertName, digest, readJSON, skillPath, writeJSON } from './catalog.mjs';

const STATE = '.skillhub-state.json';
export function targetPath(catalog, options, cwd = process.cwd()) {
  if (options.dir) return path.resolve(options.dir);
  const name = options.agent || 'codex';
  if (!Object.hasOwn(catalog.targets, name)) throw new Error(`Unknown agent: ${name}. Use targets or --dir.`);
  const target = catalog.targets[name];
  if (options.scope && !['global', 'project'].includes(options.scope)) throw new Error('Scope must be global or project');
  if (options.scope === 'project') return path.resolve(cwd, target.project);
  if (target.env && process.env[target.env]) return path.resolve(process.env[target.env], target.envSuffix);
  return path.join(os.homedir(), target.global.slice(2));
}
function plain(file) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function readState(target) {
  plain(target);
  const file = path.join(target, STATE);
  plain(file);
  if (!fs.existsSync(file)) return { schemaVersion: 1, skills: {} };
  const state = readJSON(file);
  if (state.schemaVersion !== 1 || !state.skills || Array.isArray(state.skills)) throw new Error(`Invalid state: ${file}`);
  for (const [name, entry] of Object.entries(state.skills)) {
    assertName(name);
    if (typeof entry.sha256 !== 'string' || !Array.isArray(entry.dependencies) || typeof entry.source !== 'string') throw new Error(`Invalid installed record: ${name}`);
    entry.dependencies.forEach(assertName);
  }
  return state;
}
export function installed(target) {
  const state = readState(target);
  return Object.entries(state.skills).map(([name, entry]) => {
    const dir = path.join(target, name);
    let status;
    try { status = digest(dir) === entry.sha256 ? 'clean' : 'modified'; }
    catch (error) { status = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
    return { name, ...entry, status, path: dir };
  });
}

export function planChanges({ root, catalog, target, names, remove = false, force = false, allowDowngrade = false }) {
  const state = readState(target);
  const changes = [];
  const selected = new Set(names);
  if (remove) {
    for (const [name, entry] of Object.entries(state.skills)) {
      if (!selected.has(name) && entry.dependencies.some(d => selected.has(d))) throw new Error(`${name} depends on a selected skill; remove it together with its dependency`);
    }
  }
  for (const name of names) {
    assertName(name);
    const dest = path.join(target, name);
    plain(dest);
    const previous = state.skills[name];
    if (remove && !previous) throw new Error(`Not managed by skillhub: ${name}`);
    if (fs.existsSync(dest) && !previous) throw new Error(`Unmanaged skill exists: ${dest}. Move it aside before installation.`);
    if (!remove && previous && previous.source !== catalog.name) throw new Error(`Skill ${name} belongs to another catalog: ${previous.source}`);
    const dirty = fs.existsSync(dest) && previous && digest(dest) !== previous.sha256;
    if (dirty && !force) throw new Error(`Local modifications: ${name}. Preserve your edits, or use --force (keeps a backup).`);
    const skill = catalog.skills[name];
    if (!remove && previous && !allowDowngrade) {
      const a = skill.version.split('.').map(Number), b = previous.version.split('.').map(Number);
      const index = a.findIndex((v, i) => v !== b[i]);
      if (index >= 0 && a[index] < b[index]) throw new Error(`Downgrade ${name}: ${previous.version} -> ${skill.version}; use --allow-downgrade`);
    }
    const source = remove ? null : skillPath(root, skill.path);
    const sha256 = source ? digest(source) : null;
    const unchanged = !remove && previous && fs.existsSync(dest) && !dirty && previous.sha256 === sha256 && previous.version === skill.version;
    changes.push({ name, action: remove ? 'remove' : unchanged ? 'unchanged' : previous ? 'update' : 'install', dirty: Boolean(dirty), source, sha256, version: remove ? previous.version : skill.version });
  }
  return { target, changes };
}

// A lock covers read/plan/write. All entries are staged before mutation; errors roll back.
// A process crash can leave .skillhub-txn-* recovery files; doctor exposes them.
export function applyChanges(args) {
  const { target, root, catalog } = args;
  plain(target);
  fs.mkdirSync(target, { recursive: true });
  const lock = path.join(target, '.skillhub-lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Target is locked: ${lock}. Check for an active process before recovery.`);
    throw error;
  }
  let work;
  try {
    const pending = fs.readdirSync(target).filter(name => name.startsWith('.skillhub-txn-'));
    if (pending.length) throw new Error(`Pending recovery in ${target}: ${pending.join(', ')}. Run doctor before further writes.`);
    const plan = planChanges(args);
    const changes = plan.changes.filter(c => c.action !== 'unchanged');
    if (!changes.length) return plan;
    const oldState = readState(target);
    const next = structuredClone(oldState);
    work = fs.mkdtempSync(path.join(target, '.skillhub-txn-'));
    fs.mkdirSync(path.join(work, 'old'));
    fs.mkdirSync(path.join(work, 'new'));
    writeJSON(path.join(work, 'previous-state.json'), oldState);
    writeJSON(path.join(work, 'plan.json'), plan);
    for (const item of changes) {
      if (item.action === 'remove') delete next.skills[item.name];
      else {
        const stage = path.join(work, 'new', item.name);
        fs.cpSync(item.source, stage, { recursive: true, preserveTimestamps: true });
        if (digest(stage) !== item.sha256) throw new Error(`Source changed during staging: ${item.name}`);
        next.skills[item.name] = { version: item.version, sha256: item.sha256, source: catalog.name, dependencies: catalog.skills[item.name].dependencies, installedAt: new Date().toISOString() };
      }
    }
    const applied = [];
    try {
      for (const item of changes) {
        const dest = path.join(target, item.name), backup = path.join(work, 'old', item.name);
        const step = { dest, backup, moved: false, created: false };
        applied.push(step);
        if (fs.existsSync(dest)) { fs.renameSync(dest, backup); step.moved = true; }
        if (item.action !== 'remove') { fs.renameSync(path.join(work, 'new', item.name), dest); step.created = true; }
      }
      writeJSON(path.join(work, 'next-state.json'), next);
      fs.renameSync(path.join(work, 'next-state.json'), path.join(target, STATE));
    } catch (error) {
      for (const step of applied.reverse()) {
        if (step.created) fs.rmSync(step.dest, { recursive: true, force: true });
        if (step.moved) fs.renameSync(step.backup, step.dest);
      }
      throw error;
    }
    if (changes.some(c => c.dirty)) {
      const backup = work.replace('.skillhub-txn-', '.skillhub-backup-');
      fs.renameSync(work, backup); work = null;
      return { ...plan, backup };
    }
    fs.rmSync(work, { recursive: true, force: true }); work = null;
    return plan;
  } finally {
    // Preserve transaction material on unexpected errors for inspection/recovery.
    fs.rmdirSync(lock);
  }
}

export function doctor(target) {
  const skills = installed(target);
  const recovery = fs.existsSync(target) ? fs.readdirSync(target).filter(n => /^\.skillhub-(txn-|lock)/.test(n)) : [];
  return { target, ok: recovery.length === 0 && skills.every(s => s.status === 'clean'), skills, recovery };
}
