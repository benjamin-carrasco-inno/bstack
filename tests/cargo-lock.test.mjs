import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('../plugins/bstack/scripts/cargo-lock.mjs', import.meta.url));
const LOCK_NAME = '.bstack-cargo.lock';

// Stands in for `cargo test`: "builds" this worktree's code into the shared target, then "runs" it once the
// other worktree has built too (or after 3 s, as it never does under the lock). It fails when the binary it
// runs is not the one its own worktree built.
const FAKE_CARGO_TEST = `
import fs from 'node:fs';
import path from 'node:path';
const binary = process.argv[2];
const mine = fs.readFileSync('branch.txt', 'utf8');
fs.writeFileSync(binary, mine);
fs.writeFileSync(binary + '.built-' + mine, '');
const builds = () => fs.readdirSync(path.dirname(binary)).filter(f => f.includes('.built-')).length;
for (const until = Date.now() + 3000; builds() < 2 && Date.now() < until;) await new Promise(r => setTimeout(r, 50));
const ran = fs.readFileSync(binary, 'utf8');
console.log(ran === mine ? 'ok ' + mine : 'FAILED: ' + mine + ' ran ' + ran);
process.exitCode = ran === mine ? 0 : 1;
`;

const tempDir = name => fs.mkdtempSync(path.join(os.tmpdir(), `bstack-cargo-lock-${name}-`));

function envWith(targetDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'CARGO_TARGET_DIR'));
  return targetDir ? { ...env, CARGO_TARGET_DIR: targetDir } : env;
}

function wrapped(args, { cwd, targetDir, onStderr = () => {} }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WRAPPER, ...args], { cwd, env: envWith(targetDir) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; onStderr(stderr); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function twoWorktrees() {
  const script = path.join(tempDir('bin'), 'fake-cargo-test.mjs');
  fs.writeFileSync(script, FAKE_CARGO_TEST);
  const target = tempDir('target');
  const trees = ['feat-a', 'feat-b'].map(branch => {
    const dir = tempDir(branch);
    fs.writeFileSync(path.join(dir, 'branch.txt'), branch);
    return dir;
  });
  const runBoth = targetDir => Promise.all(trees.map(cwd => wrapped([process.execPath, script, path.join(target, 'test-binary')], { cwd, targetDir })));
  return { target, runBoth };
}

test('two worktrees sharing a target dir each run their own build under the lock', async () => {
  const { target, runBoth } = twoWorktrees();
  const runs = await runBoth(target);
  assert.deepEqual(runs.map(r => [r.code, r.stdout.trim()]), [[0, 'ok feat-a'], [0, 'ok feat-b']]);
  assert.equal(runs.filter(r => /waiting for .*\.bstack-cargo\.lock, held by process \d+/.test(r.stderr)).length, 1);
  assert.equal(fs.existsSync(path.join(target, LOCK_NAME)), false);
});

test('without the lock the same two runs test each other\'s build', async () => {
  const { runBoth } = twoWorktrees();
  const runs = await runBoth(undefined);
  assert.ok(runs.some(r => r.code === 1 && /^FAILED: /.test(r.stdout)), JSON.stringify(runs));
});

test('a lock left by a process that is no longer running is taken over', async () => {
  const target = tempDir('target');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(path.join(target, LOCK_NAME), String(dead));
  const run = await wrapped([process.execPath, '-e', 'console.log("ran")'], { cwd: target, targetDir: target });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), 'ran');
  assert.match(run.stderr, new RegExp(`taking over .* from process ${dead}, which is no longer running`));
  assert.equal(fs.existsSync(path.join(target, LOCK_NAME)), false);
});

test('a lock held by a running process is waited for, not taken over', async () => {
  const target = tempDir('target');
  const lock = path.join(target, LOCK_NAME);
  fs.writeFileSync(lock, String(process.pid));
  let released = false;
  const releaseOnWait = stderr => { if (!released && /waiting for/.test(stderr)) { released = true; setTimeout(() => fs.rmSync(lock), 500); } };
  const run = await wrapped([process.execPath, '-e', 'console.log("ran")'], { cwd: target, targetDir: target, onStderr: releaseOnWait });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), 'ran');
  assert.match(run.stderr, new RegExp(`waiting for .*, held by process ${process.pid}`));
  assert.doesNotMatch(run.stderr, /taking over/);
});

test('a lock whose wrapper died while its cargo still runs is waited for, not taken over', async () => {
  const target = tempDir('target');
  const lock = path.join(target, LOCK_NAME);
  const deadWrapper = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, `${deadWrapper} ${process.pid}`);
  let released = false;
  const releaseOnWait = stderr => { if (!released && /waiting for/.test(stderr)) { released = true; setTimeout(() => fs.rmSync(lock), 500); } };
  const run = await wrapped([process.execPath, '-e', 'console.log("ran")'], { cwd: target, targetDir: target, onStderr: releaseOnWait });
  assert.equal(run.code, 0);
  assert.match(run.stderr, new RegExp(`held by process ${deadWrapper} and ${process.pid}`));
  assert.doesNotMatch(run.stderr, /taking over/);
});

test('while the command runs, the lock names the wrapper and the command', async () => {
  const target = tempDir('target');
  const run = await wrapped([process.execPath, '-e', `console.log(require('fs').readFileSync(${JSON.stringify(path.join(target, LOCK_NAME))}, 'utf8') + ' ' + process.pid)`], { cwd: target, targetDir: target });
  const [wrapperPid, childPid, ownPid] = run.stdout.trim().split(/\s+/);
  assert.equal(childPid, ownPid);
  assert.notEqual(wrapperPid, ownPid);
});

test('without CARGO_TARGET_DIR the wrapper only runs the command and passes its exit code', async () => {
  const cwd = tempDir('plain');
  const run = await wrapped([process.execPath, '-e', 'console.log("out"); process.exit(3)'], { cwd, targetDir: undefined });
  assert.deepEqual([run.code, run.stdout.trim(), run.stderr], [3, 'out', '']);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

const hasCargo = spawnSync('cargo', ['--version']).status === 0;

function crateWorktree(lib) {
  const dir = tempDir('crate');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "branchy"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), `pub fn status() -> &'static str { "${lib}" }\n`);
  fs.writeFileSync(path.join(dir, 'tests', 'own.rs'), '#[test]\nfn status_is_ok() { assert_eq!(branchy::status(), "ok"); }\n');
  return dir;
}

test('real cargo: a test that fails only on one worktree fails there, also when run after the other', { skip: !hasCargo && 'cargo is not on PATH' }, async () => {
  const target = tempDir('cargo-target');
  const passing = crateWorktree('ok');
  const failing = crateWorktree('broken');
  const cargoTest = cwd => wrapped(['cargo', 'test', '--offline', '--quiet'], { cwd, targetDir: target });
  const first = await cargoTest(passing);
  const second = await cargoTest(failing);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.notEqual(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout + second.stderr, /left: "broken"/);
});

// A program named cargo that is node: `cargo run` then runs the file `run` in its working directory.
function fakeCargo() {
  const bin = path.join(tempDir('cargo-bin'), process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  try { fs.linkSync(process.execPath, bin); } catch { fs.copyFileSync(process.execPath, bin); fs.chmodSync(bin, 0o755); }
  return bin;
}

test('a wrapped cargo run of an app that keeps running does not hold up other wrapped commands', async () => {
  const target = tempDir('target');
  const worktree = tempDir('app');
  fs.writeFileSync(path.join(worktree, 'run'), 'console.log("server listening"); setTimeout(() => {}, 30000);');
  const server = spawn(process.execPath, [WRAPPER, fakeCargo(), 'run'], { cwd: worktree, env: envWith(target) });
  try {
    let serverErr = '';
    server.stderr.on('data', d => { serverErr += d; });
    await new Promise(resolve => server.stdout.once('data', resolve));
    const test = await wrapped([process.execPath, '-e', 'console.log("tests ran")'], { cwd: worktree, targetDir: target });
    assert.deepEqual([test.code, test.stdout.trim(), test.stderr], [0, 'tests ran', '']);
    assert.equal(server.exitCode, null);
    assert.match(serverErr, /cargo run takes no lock/);
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
    else server.kill();
    server.stdout.destroy();
    server.stderr.destroy();
  }
});

test('under the lock the command\'s exit code passes through and the lock is released', async () => {
  const target = tempDir('target');
  const run = await wrapped([process.execPath, '-e', 'process.exit(4)'], { cwd: target, targetDir: target });
  assert.deepEqual([run.code, run.stderr], [4, '']);
  assert.deepEqual(fs.readdirSync(target), []);
});
