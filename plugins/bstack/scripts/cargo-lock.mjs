#!/usr/bin/env node
// Runs a command while holding an exclusive lock on <CARGO_TARGET_DIR>/.bstack-cargo.lock, build and run
// together. Cargo's own lock covers compiling only, so worktrees sharing one target dir otherwise rebuild
// each other's test binaries between build and run (#153). Without CARGO_TARGET_DIR it only runs the command.
// Usage: node cargo-lock.mjs cargo test --workspace --locked
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_NAME = '.bstack-cargo.lock';
const POLL_MS = 250;
const say = msg => process.stderr.write(`bstack cargo-lock: ${msg}\n`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function ownerOf(file) {
  try { return Number.parseInt(fs.readFileSync(file, 'utf8'), 10) || null; } catch { return null; }
}

// A hard link appears atomically with the owner's pid already in it, so no reader sees an empty lock.
function claim(file) {
  const mine = `${file}.${process.pid}`;
  fs.writeFileSync(mine, String(process.pid));
  try {
    fs.linkSync(mine, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

// Only the holder of the takeover lock may delete a lock it did not create, and only after it read a dead
// owner while holding it; so a lock taken over by a live process is never deleted by a second waiter.
function removeDead(file) {
  const takeover = `${file}.takeover`;
  if (!claim(takeover)) {
    const owner = ownerOf(takeover);
    if (owner && !alive(owner)) fs.rmSync(takeover, { force: true });
    return;
  }
  try {
    const owner = ownerOf(file);
    if (owner && !alive(owner)) fs.rmSync(file, { force: true });
  } finally {
    fs.rmSync(takeover, { force: true });
  }
}

async function acquire(file) {
  let told = false;
  while (!claim(file)) {
    const owner = ownerOf(file);
    if (owner && !alive(owner)) {
      say(`taking over ${file} from process ${owner}, which is no longer running`);
      removeDead(file);
    } else if (owner && !told) {
      say(`waiting for ${file}, held by process ${owner}`);
      told = true;
    }
    await sleep(POLL_MS);
  }
}

function release(file) {
  if (ownerOf(file) === process.pid) fs.rmSync(file, { force: true });
}

function run(program, args) {
  return new Promise(resolve => {
    const child = spawn(program, args, { stdio: 'inherit' });
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.on('error', e => { say(`${program}: ${e.message}`); resolve(127); });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main([program, ...args]) {
  if (!program) {
    say('usage: node cargo-lock.mjs cargo <subcommand> [args...]');
    return 2;
  }
  const target = process.env.CARGO_TARGET_DIR;
  if (!target) return run(program, args);
  const lock = path.join(path.resolve(target), LOCK_NAME);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  await acquire(lock);
  try {
    return await run(program, args);
  } finally {
    release(lock);
  }
}

process.exitCode = await main(process.argv.slice(2));
