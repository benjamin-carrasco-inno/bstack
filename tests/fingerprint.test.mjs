import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'plugins', 'bstack', 'scripts', 'fingerprint.mjs');
const MAKE_REPO = path.join(here, 'fixtures', 'comment-critic', 'make-repo.mjs');

const scratchDirs = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-fingerprint-'));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const runScript = (cwd, env = process.env) => spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });

function fixtureRepo() {
  const root = scratch();
  return execFileSync(process.execPath, [MAKE_REPO, path.join(root, 'repo')], { encoding: 'utf8' }).trim();
}

function fingerprintLine(cwd) {
  const res = runScript(cwd);
  assert.equal(res.status, 0, res.stderr);
  const last = res.stdout.trimEnd().split('\n').pop();
  assert.match(last, /^fingerprint: [0-9a-f]{64}$/);
  return { line: last, out: res.stdout };
}

const edit = (work, file, from, to) => {
  const full = path.join(work, file);
  const before = fs.readFileSync(full, 'utf8');
  assert.ok(before.includes(from), `${file} holds ${from}`);
  fs.writeFileSync(full, before.replace(from, to));
};

test('two runs on an unchanged checkout give the same fingerprint', () => {
  const work = fixtureRepo();
  assert.equal(fingerprintLine(work).line, fingerprintLine(work).line);
});

test('an edit to an untracked file changes it', () => {
  const work = fixtureRepo();
  const before = fingerprintLine(work).line;
  edit(work, 'src/api.mjs', 'attempt < 2', 'attempt < 3');
  assert.notEqual(fingerprintLine(work).line, before);
});

test('a same-length edit of an already-modified tracked line changes it', () => {
  const work = fixtureRepo();
  const before = fingerprintLine(work).line;
  edit(work, 'src/cart.mjs', '// add the quantity to the count', '// add the quantity to the tally');
  assert.notEqual(fingerprintLine(work).line, before);
});

test('a tracked file deleted without git rm is listed, and files sorted after it are still hashed', () => {
  const work = fixtureRepo();
  const before = fingerprintLine(work).line;
  fs.rmSync(path.join(work, 'package.json'));
  const deleted = fingerprintLine(work);
  assert.match(deleted.out, /^deleted package\.json$/m);
  assert.notEqual(deleted.line, before);
  edit(work, 'test/cart.test.mjs', 'sums cents', 'sums pence');
  assert.notEqual(fingerprintLine(work).line, deleted.line);
});

test('a new untracked file changes it, an ignored one does not', () => {
  const work = fixtureRepo();
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '\n*.log\n');
  const before = fingerprintLine(work).line;
  fs.writeFileSync(path.join(work, 'debug.log'), 'noise');
  assert.equal(fingerprintLine(work).line, before);
  fs.writeFileSync(path.join(work, 'src', 'new.mjs'), 'export const x = 1;\n');
  assert.notEqual(fingerprintLine(work).line, before);
});

test('a nested repository shows up as a directory entry', () => {
  const work = fixtureRepo();
  execFileSync('git', ['init', '-q', path.join(work, 'vendor', 'nested')]);
  assert.match(fingerprintLine(work).out, /^dir vendor\/nested\/$/m);
});

test('it fails without output outside a git repository', () => {
  const dir = scratch();
  const res = runScript(dir, { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /not a git repository/i);
});
