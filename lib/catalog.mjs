import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function assertName(name) {
  if (typeof name !== 'string' || name.length > 63 || !NAME.test(name)) throw new Error(`Invalid name: ${name}`);
}
export function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJSON(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

// Do not copy links, device files or traversal paths into an agent's instruction directory.
export function filesIn(root) {
  const files = [];
  function walk(dir, prefix = '') {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Not a plain directory: ${dir}`);
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${rel}`);
      if (item.isDirectory()) walk(path.join(dir, item.name), rel);
      else if (item.isFile()) files.push(rel);
      else throw new Error(`Unsupported file type: ${rel}`);
    }
  }
  walk(root);
  return files;
}
export function digest(root) {
  const hash = crypto.createHash('sha256');
  for (const rel of filesIn(root).sort()) {
    const data = fs.readFileSync(path.join(root, rel));
    hash.update(JSON.stringify([rel, data.length, fs.statSync(path.join(root, rel)).mode & 0o111]));
    hash.update(data);
  }
  return hash.digest('hex');
}
export function skillPath(root, rel) {
  if (typeof rel !== 'string' || !/^skills\/[a-z0-9-]+$/.test(rel)) throw new Error(`Invalid skill path: ${rel}`);
  const full = path.resolve(root, rel);
  for (const part of [path.join(root, 'skills'), full]) {
    if (fs.lstatSync(part).isSymbolicLink()) throw new Error(`Symlink path: ${part}`);
  }
  return full;
}

export function loadCatalog(root) {
  const catalog = readJSON(path.join(root, 'catalog.json'));
  if (catalog.schemaVersion !== 1 || !catalog.skills || !catalog.targets || !catalog.collections) throw new Error('Unsupported or incomplete catalog');
  if (typeof catalog.name !== 'string' || !catalog.name.trim()) throw new Error('Catalog needs a name');
  for (const [name, skill] of Object.entries(catalog.skills)) {
    assertName(name);
    if (!VERSION.test(skill.version) || typeof skill.description !== 'string' || !skill.description.trim()) throw new Error(`Invalid metadata: ${name}`);
    if (skill.path !== `skills/${name}`) throw new Error(`Skill path must be skills/${name}`);
    if (!Array.isArray(skill.dependencies) || skill.dependencies.some(d => !Object.hasOwn(catalog.skills, d))) throw new Error(`Invalid dependencies: ${name}`);
    skillPath(root, skill.path);
  }
  for (const [name, members] of Object.entries(catalog.collections)) {
    assertName(name);
    if (!Array.isArray(members) || members.some(n => !Object.hasOwn(catalog.skills, n))) throw new Error(`Invalid collection: ${name}`);
  }
  for (const [name, target] of Object.entries(catalog.targets)) {
    assertName(name);
    if (typeof target.global !== 'string' || typeof target.project !== 'string') throw new Error(`Invalid target: ${name}`);
    if (!target.global.startsWith('~/') || path.isAbsolute(target.project) || target.project.split(/[\\/]/).includes('..')) throw new Error(`Invalid target paths: ${name}`);
    if (target.env && (!/^[A-Z_]+$/.test(target.env) || target.envSuffix !== 'skills')) throw new Error(`Invalid target environment: ${name}`);
  }
  resolveSkills(catalog, Object.keys(catalog.skills));
  return catalog;
}

export function resolveSkills(catalog, names) {
  const visiting = new Set(), done = new Set(), result = [];
  function visit(name) {
    if (!Object.hasOwn(catalog.skills, name)) throw new Error(`Unknown skill: ${name}`);
    if (visiting.has(name)) throw new Error(`Dependency cycle: ${[...visiting, name].join(' -> ')}`);
    if (done.has(name)) return;
    visiting.add(name);
    for (const dep of catalog.skills[name].dependencies) visit(dep);
    visiting.delete(name); done.add(name); result.push(name);
  }
  names.forEach(visit);
  return result;
}

export function validate(root, catalog) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !Object.hasOwn(catalog.skills, entry.name)) throw new Error(`Unregistered skill content: ${entry.name}`);
  }
  for (const [name, skill] of Object.entries(catalog.skills)) {
    const dir = skillPath(root, skill.path);
    const files = filesIn(dir);
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!front || !new RegExp(`^name: ${name}$`, 'm').test(front) || !/^description: \S.+$/m.test(front)) throw new Error(`Invalid SKILL.md frontmatter: ${name} (use plain name and one-line description)`);
    for (const file of files) {
      if (/(^|\/)(\.git|node_modules|\.env(?:\..*)?|Cookies|Login Data|skill\.sig|skill\.manifest)(\/|$)|\.(jsonl|tgz)$/.test(file)) throw new Error(`Runtime/private artifact in ${name}: ${file}`);
      const data = fs.readFileSync(path.join(dir, file), 'utf8');
      // A small guard against common accidental credentials, not a full security audit.
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/.test(data)) throw new Error(`Potential credential in ${name}/${file}`);
    }
    result.push({ name, version: skill.version, files: files.length, sha256: digest(dir) });
  }
  return result;
}
