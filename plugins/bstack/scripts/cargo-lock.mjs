#!/usr/bin/env node
// Runs a command while holding an exclusive lock on <CARGO_TARGET_DIR>/.bstack-cargo.lock, build and run
// together. Cargo's own lock covers compiling only, so worktrees sharing one target dir otherwise rebuild
// each other's test binaries between build and run (#153). Worktrees of one workspace also get the same
// build hashes, and cargo judges freshness by mtime, so a worktree whose sources are older than another's
// build would run that build: the wrapper first marks this worktree's workspace sources as changed.
// Without CARGO_TARGET_DIR it only runs the command; `cargo run` takes no lock, as its app may run for hours.
// Usage: node cargo-lock.mjs cargo test --workspace --locked
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cargoSubcommand, holdsNoLock, isCargo } from './lib/cargo.mjs';

const LOCK_NAME = '.bstack-cargo.lock';
const POLL_MS = 250;
const WORKSPACE_SOURCES = ['src', 'tests', 'benches', 'examples', 'build.rs', 'Cargo.toml'];
const say = msg => process.stderr.write(`bstack cargo-lock: ${msg}\n`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function ownersOf(file) {
  try {
    const pids = fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number).filter(Number.isInteger);
    return pids.length ? pids : null;
  } catch {
    return null;
  }
}

const deadOwners = owners => owners !== null && !owners.some(alive);

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

// The lock names the child too, so a wrapper killed hard (which on Windows leaves cargo running) still holds it.
function recordChild(file, childPid) {
  const next = `${file}.${process.pid}`;
  try {
    fs.writeFileSync(next, `${process.pid} ${childPid}`);
    fs.renameSync(next, file);
  } catch {
    fs.rmSync(next, { force: true });
  }
}

// Only the holder of the takeover lock may delete a lock it did not create, and only after it read dead
// owners while holding it; so a lock taken over by a live process is never deleted by a second waiter.
function removeDead(file) {
  const takeover = `${file}.takeover`;
  if (!claim(takeover)) {
    if (deadOwners(ownersOf(takeover))) fs.rmSync(takeover, { force: true });
    return;
  }
  try {
    if (deadOwners(ownersOf(file))) fs.rmSync(file, { force: true });
  } finally {
    fs.rmSync(takeover, { force: true });
  }
}

async function acquire(file) {
  let told = false;
  while (!claim(file)) {
    const owners = ownersOf(file);
    if (deadOwners(owners)) {
      say(`taking over ${file} from process ${owners.join(' and ')}, which is no longer running`);
      removeDead(file);
    } else if (owners && !told) {
      say(`waiting for ${file}, held by process ${owners.join(' and ')}`);
      told = true;
    }
    await sleep(POLL_MS);
  }
}

function release(file) {
  if (ownersOf(file)?.[0] === process.pid) fs.rmSync(file, { force: true });
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

function workspaceMembers(program, args) {
  const manifest = optionValue(args, '--manifest-path');
  const cwd = path.resolve(optionValue(args, '-C') ?? '.');
  const metadata = spawnSync(program, ['metadata', '--no-deps', '--format-version', '1', ...(manifest ? ['--manifest-path', manifest] : [])], { cwd, encoding: 'utf8' });
  if (metadata.status !== 0) return [];
  return JSON.parse(metadata.stdout).packages.map(p => path.dirname(p.manifest_path));
}

function touch(entry, now) {
  const stat = fs.statSync(entry, { throwIfNoEntry: false });
  if (stat?.isDirectory()) for (const name of fs.readdirSync(entry)) touch(path.join(entry, name), now);
  else if (stat) fs.utimesSync(entry, now, now);
}

function markSourcesChanged(program, args) {
  const now = new Date();
  for (const member of workspaceMembers(program, args)) {
    for (const name of WORKSPACE_SOURCES) touch(path.join(member, name), now);
  }
}

function run(program, args, onSpawn = () => {}) {
  return new Promise(resolve => {
    const child = spawn(program, args, { stdio: 'inherit' });
    if (child.pid) onSpawn(child.pid);
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
  if (isCargo(program) && holdsNoLock(cargoSubcommand(args))) {
    say('cargo run takes no lock: the app it starts may run for hours, and cargo\'s own lock covers its build');
    markSourcesChanged(program, args);
    return run(program, args);
  }
  const lock = path.join(path.resolve(target), LOCK_NAME);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  await acquire(lock);
  try {
    if (isCargo(program)) markSourcesChanged(program, args);
    return await run(program, args, childPid => recordChild(lock, childPid));
  } finally {
    release(lock);
  }
}

process.exitCode = await main(process.argv.slice(2));
