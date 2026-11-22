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

function fingerprintLine(cwd, env) {
  const res = runScript(cwd, env);
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

const git = (work, ...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });

function assertChangedBy(act, env) {
  const work = fixtureRepo();
  const before = fingerprintLine(work, env).line;
  act(work);
  assert.notEqual(fingerprintLine(work, env).line, before);
}

test('staging every change changes it', () => {
  assertChangedBy(work => git(work, 'add', '-A'));
});

test('a mode change in the index alone changes it', () => {
  assertChangedBy(work => git(work, 'update-index', '--chmod=+x', 'src/cart.mjs'));
});

test('switching to a new branch on the same commit changes it', () => {
  assertChangedBy(work => git(work, 'switch', '-q', '-c', 'other'));
});

test('detaching HEAD on the same commit changes it', () => {
  assertChangedBy(work => git(work, 'switch', '-q', '--detach'));
});

test('marking a file skip-worktree changes it', () => {
  assertChangedBy(work => git(work, 'update-index', '--skip-worktree', 'src/cart.mjs'));
});

test('an info/exclude pattern that hides a new file changes it', () => {
  assertChangedBy(work => {
    fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '\nsrc/evil.mjs\n');
    fs.writeFileSync(path.join(work, 'src', 'evil.mjs'), 'export default 1;\n');
  });
});

test('a core.excludesFile pattern that hides a new file changes it', () => {
  const excludes = path.join(scratch(), 'ignore');
  fs.writeFileSync(excludes, '*.log\n');
  assertChangedBy(work => {
    git(work, 'config', 'core.excludesFile', excludes);
    fs.appendFileSync(excludes, 'src/evil.mjs\n');
    fs.writeFileSync(path.join(work, 'src', 'evil.mjs'), 'export default 1;\n');
  });
});

test('a pattern in the default global ignore file that hides a new file changes it', () => {
  const xdg = scratch();
  fs.mkdirSync(path.join(xdg, 'git'));
  const env = { ...process.env, XDG_CONFIG_HOME: xdg };
  assertChangedBy(work => {
    fs.writeFileSync(path.join(xdg, 'git', 'ignore'), 'src/evil.mjs\n');
    fs.writeFileSync(path.join(work, 'src', 'evil.mjs'), 'export default 1;\n');
  }, env);
});

test('an edit inside a nested repository changes it, and the nested repository is listed by its path', () => {
  const work = fixtureRepo();
  const nested = path.join(work, 'vendor', 'nested');
  execFileSync('git', ['init', '-q', nested]);
  fs.writeFileSync(path.join(nested, 'a.js'), '// original comment\n');
  const before = fingerprintLine(work).line;
  fs.writeFileSync(path.join(nested, 'a.js'), '// edited by critic\n');
  const edited = fingerprintLine(work);
  assert.notEqual(edited.line, before);
  assert.match(edited.out, /^repo vendor\/nested\/$/m);
});

test('a worktree created inside the checkout and removed again leaves it equal', () => {
  const work = fixtureRepo();
  const before = fingerprintLine(work).line;
  const agent = path.join(work, '.claude', 'worktrees', 'agent-x');
  git(work, 'worktree', 'add', '-q', '-b', 'worktree-agent-x', agent);
  fs.writeFileSync(path.join(agent, 'scratch.txt'), 'critic notes\n');
  git(work, 'worktree', 'remove', '--force', agent);
  git(work, 'branch', '-D', 'worktree-agent-x');
  assert.equal(fingerprintLine(work).line, before);
});

test('another worktree of the same repository inside the checkout is listed, but edits in it do not change it', () => {
  const work = fixtureRepo();
  const other = path.join(work, '.claude', 'worktrees', 'other-session');
  git(work, 'worktree', 'add', '-q', '-b', 'other-session', other);
  const before = fingerprintLine(work);
  fs.writeFileSync(path.join(other, 'package.json'), 'edited by another session\n');
  const after = fingerprintLine(work);
  assert.match(after.out, /^worktree \.claude\/worktrees\/other-session\/$/m);
  assert.equal(after.line, before.line);
});

test('it fails without output outside a git repository', () => {
  const dir = scratch();
  const res = runScript(dir, { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /not a git repository/i);
});
