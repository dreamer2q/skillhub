import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadCatalog, readJSON, writeJSON } from '../lib/catalog.mjs';
import { applyChanges } from '../lib/install.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repo, 'bin/skillhub.mjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source'), target = path.join(temp, 'destination');
  fs.mkdirSync(root);
  const catalog = { schemaVersion: 1, name: 'test/catalog', skills: {}, collections: { starter: ['alpha', 'beta'] }, targets: { codex: { global: '~/.codex/skills', project: '.agents/skills' }, claude: { global: '~/.claude/skills', project: '.claude/skills' } } };
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name} skill\n---\n\nUse ${name}.\n`);
    catalog.skills[name] = { version: '1.0.0', description: `Test ${name}`, path: `skills/${name}`, dependencies: name === 'beta' ? ['alpha'] : [] };
  }
  writeJSON(path.join(root, 'catalog.json'), catalog);
  function run(...args) {
    const proc = spawnSync(process.execPath, [cli, ...args, '--source', root, '--dir', target, '--json'], { encoding: 'utf8' });
    return { code: proc.status, ...JSON.parse(proc.stdout) };
  }
  return { temp, root, target, run, catalog, save: () => writeJSON(path.join(root, 'catalog.json'), catalog) };
}
test('install dependencies, idempotency, dependency-safe removal', t => {
  const f = fixture(t);
  assert.equal(f.run('install', 'beta').code, 0);
  assert.deepEqual(f.run('installed').data.map(s => s.name), ['alpha', 'beta']);
  assert.ok(f.run('install', 'beta').data.changes.every(c => c.action === 'unchanged'));
  assert.match(f.run('remove', 'alpha').error, /depends/);
  assert.equal(f.run('remove', 'alpha', 'beta').code, 0);
  assert.deepEqual(f.run('installed').data, []);
});
test('dry run does not create destination', t => {
  const f = fixture(t);
  assert.equal(f.run('install', '--collection', 'starter', '--dry-run').data.changes.length, 2);
  assert.equal(fs.existsSync(f.target), false);
});
test('update protects edits, force preserves exact old content', t => {
  const f = fixture(t);
  f.run('install', 'alpha');
  fs.appendFileSync(path.join(f.target, 'alpha/SKILL.md'), 'local edit');
  f.catalog.skills.alpha.version = '1.0.1'; f.save();
  assert.match(f.run('update').error, /Local modifications/);
  const result = f.run('update', '--force');
  assert.equal(result.code, 0);
  assert.match(fs.readFileSync(path.join(result.data.backup, 'old/alpha/SKILL.md'), 'utf8'), /local edit/);
  assert.equal(f.run('installed').data[0].version, '1.0.1');
  assert.equal(f.run('doctor').data.ok, true);
});
test('unmanaged files cannot be overwritten, even with force', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(f.target, 'alpha/SKILL.md'), 'original');
  assert.match(f.run('install', 'alpha', '--force').error, /Unmanaged/);
  assert.equal(fs.readFileSync(path.join(f.target, 'alpha/SKILL.md'), 'utf8'), 'original');
});
test('whole batch preflight prevents partial install on conflict', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'beta'), { recursive: true });
  assert.equal(f.run('install', '--all').code, 1);
  assert.equal(fs.existsSync(path.join(f.target, 'alpha')), false);
});
test('injected second-skill failure rolls back files and state', t => {
  const f = fixture(t);
  f.run('install', 'alpha');
  const oldState = fs.readFileSync(path.join(f.target, '.skillhub-state.json'), 'utf8');
  fs.appendFileSync(path.join(f.root, 'skills/alpha/SKILL.md'), 'new content');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, dest) => {
    if (!injected && source.includes(`${path.sep}new${path.sep}beta`)) { injected = true; throw new Error('Injected rename failure'); }
    return rename(source, dest);
  };
  try {
    assert.throws(() => applyChanges({ root: f.root, catalog: loadCatalog(f.root), target: f.target, names: ['alpha', 'beta'] }), /Injected/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(f.target, '.skillhub-state.json'), 'utf8'), oldState);
  assert.doesNotMatch(fs.readFileSync(path.join(f.target, 'alpha/SKILL.md'), 'utf8'), /new content/);
  assert.equal(fs.existsSync(path.join(f.target, 'beta')), false);
  assert.equal(fs.existsSync(path.join(f.target, '.skillhub-lock')), false);
  assert.match(f.run('update').error, /Pending recovery/);
});
test('cycles and traversal paths rejected', t => {
  const f = fixture(t);
  f.catalog.skills.alpha.dependencies = ['beta']; f.save();
  assert.match(f.run('install', 'beta').error, /cycle/);
  f.catalog.skills.alpha.dependencies = []; f.catalog.skills.alpha.path = '../elsewhere'; f.save();
  assert.match(f.run('install', 'alpha').error, /path/);
});
test('source symlinks rejected before installation', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'catalog.json'), path.join(f.root, 'skills/alpha/link'));
  assert.match(f.run('install', 'alpha').error, /Symlinks/);
  assert.equal(fs.existsSync(path.join(f.target, 'alpha')), false);
});
test('destination symlink protected', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.symlinkSync(path.join(f.root, 'skills/alpha'), path.join(f.target, 'alpha'));
  assert.match(f.run('install', 'alpha').error, /symlink/);
});
test('lock blocks concurrent write and doctor reports it', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, '.skillhub-lock'), { recursive: true });
  assert.match(f.run('install', 'alpha').error, /locked/);
  assert.equal(f.run('doctor').code, 1);
});
test('missing installation repaired; downgrade requires explicit option', t => {
  const f = fixture(t);
  f.run('install', 'alpha');
  fs.rmSync(path.join(f.target, 'alpha'), { recursive: true });
  assert.equal(f.run('doctor').data.skills[0].status, 'missing');
  assert.equal(f.run('update').code, 0);
  f.catalog.skills.alpha.version = '0.9.0'; f.save();
  assert.match(f.run('update').error, /Downgrade/);
  assert.equal(f.run('update', '--allow-downgrade').code, 0);
});
test('create, bump, validate and install an authored skill', t => {
  const f = fixture(t);
  assert.equal(f.run('create', 'gamma', '--description', 'Handle gamma workflows').code, 0);
  assert.equal(f.run('bump', 'gamma', 'minor').data.version, '0.2.0');
  assert.equal(f.run('validate').code, 0);
  assert.equal(f.run('install', 'gamma').code, 0);
  assert.equal(f.run('create', 'gamma', '--description', 'duplicate').code, 1);
});
test('catalog identity cannot take ownership of installed skill', t => {
  const f = fixture(t);
  f.run('install', 'alpha');
  f.catalog.name = 'other/catalog'; f.save();
  assert.match(f.run('install', 'alpha').error, /another catalog/);
});
test('validation rejects credentials and recording artifacts', t => {
  const f = fixture(t);
  const p = path.join(f.root, 'skills/alpha/data.txt');
  fs.writeFileSync(p, 'ghp_' + 'a'.repeat(36));
  assert.match(f.run('validate').error, /credential/);
  fs.unlinkSync(p);
  fs.writeFileSync(path.join(f.root, 'skills/alpha/session.jsonl'), '{}');
  assert.match(f.run('validate').error, /artifact/);
});
test('JSON argument errors and empty update are well formed', t => {
  const f = fixture(t);
  assert.equal(f.run('update').code, 0);
  assert.equal(f.run('install', 'alpha', '--typo').ok, false);
  assert.equal(f.run('create', 'gamma', '--dry-run').code, 1);
});
test('unregistered packaged skill content is rejected', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'skills/unregistered'));
  assert.match(f.run('validate').error, /Unregistered/);
});
test('project target adapters install to separate agent paths', t => {
  const f = fixture(t);
  for (const [agent, dir] of [['codex', '.agents'], ['claude', '.claude']]) {
    const result = spawnSync(process.execPath, [cli, 'install', 'alpha', '--source', f.root, '--agent', agent, '--scope', 'project', '--json'], { cwd: f.temp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout);
    assert.ok(fs.existsSync(path.join(f.temp, dir, 'skills/alpha/SKILL.md')));
  }
});
test('packaged CLI works without original source checkout', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pack-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: repo, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const [artifact] = JSON.parse(pack.stdout);
  assert.ok(artifact.files.some(f => f.path === 'skills/browser-cdp/SKILL.md'));
  assert.ok(!artifact.files.some(f => f.path.startsWith('test/') || f.path.startsWith('.github/')));
  const prefix = path.join(temp, 'prefix');
  const install = spawnSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, artifact.filename)], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const result = spawnSync(process.execPath, [path.join(prefix, 'node_modules/@dreamer2q/skillhub/bin/skillhub.mjs'), 'install', '--collection', 'starter', '--dir', path.join(temp, 'skills'), '--json'], { cwd: temp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readJSON(path.join(temp, 'skills/.skillhub-state.json')).skills['browser-cdp'].version, '1.0.0');
});
