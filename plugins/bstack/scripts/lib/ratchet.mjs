import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, countSource, decodeSource, syntaxFor } from '../comments.mjs';
import { parseGit } from './shell.mjs';

const COMMENTS_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'comments.mjs').replace(/\\/g, '/');
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '-t', '--template',
  '--fixup', '--squash', '--author', '--date', '--cleanup', '--trailer', '--pathspec-from-file']);
const VALUE_SHORTS = 'mFCct';
const ATTACHED_SHORTS = 'Su';
const ZERO = /^0+$/;
const REGULAR = /^100(644|755)$/;

export function parseCommit(rest) {
  const opts = { all: false, include: false, dryRun: false, paths: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { opts.paths.push(...rest.slice(i + 1)); break; }
    if (VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('--')) {
      if (a === '--all') opts.all = true;
      else if (a === '--include') opts.include = true;
      else if (a === '--dry-run') opts.dryRun = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const flag = a[k];
        if (flag === 'a') opts.all = true;
        else if (flag === 'i') opts.include = true;
        if (VALUE_SHORTS.includes(flag)) { if (k === a.length - 1) i++; break; }
        if (ATTACHED_SHORTS.includes(flag)) break;
      }
      continue;
    }
    opts.paths.push(a);
  }
  return opts;
}

export function commentRatchet({ cwd, repo, rest, prior }, deps) {
  const opts = parseCommit(rest);
  if (opts.dryRun) return null;
  let root, realIndex;
  try {
    [root, realIndex] = deps.git(repo, ['rev-parse', '--show-toplevel', '--git-path', 'index']).trim().split('\n').map(s => s.trim());
  } catch { return null; }
  realIndex = path.resolve(repo, realIndex);
  if (!deps.exists(path.join(root, BASELINE)) && !inIndex(root, {}, deps)) return null;

  const adds = prior.filter(p => p.cmd === 'git' && /^(add|stage)$/.test(parseGit(p.args).sub));
  const rebuild = adds.length || opts.all || opts.paths.length;
  const temp = rebuild ? path.join(os.tmpdir(), `bstack-ratchet-${process.pid}-${Date.now()}.index`) : null;
  const env = temp ? { GIT_INDEX_FILE: temp } : {};
  try {
    if (temp) {
      if (deps.exists(realIndex)) fs.copyFileSync(realIndex, temp);
      for (const add of adds) replayAdd(add, cwd, repo, root, env, deps);
      if (opts.all) tryGit(repo, ['add', '-u'], env, deps);
      else if (opts.paths.length) tryGit(repo, ['add', '-u', '--', ...opts.paths], env, deps);
    }
    return check(root, repo, opts, env, deps);
  } finally {
    if (temp) for (const f of [temp, `${temp}.lock`]) fs.rmSync(f, { force: true });
  }
}

function replayAdd(add, cwd, repo, root, env, deps) {
  const { dir, rest } = parseGit(add.args);
  const where = dir ? path.resolve(cwd, dir) : cwd;
  if (where !== repo) {
    let top;
    try { top = deps.git(where, ['rev-parse', '--show-toplevel']).trim(); } catch { return; }
    if (path.resolve(top) !== path.resolve(root)) return;
  }
  tryGit(where, ['add', ...rest], env, deps);
}

function tryGit(cwd, args, env, deps) {
  try { deps.git(cwd, args, { env, timeout: 45000 }); } catch {}
}

function inIndex(root, env, deps) {
  try { deps.git(root, ['cat-file', '-e', `:${BASELINE}`], { env }); return true; } catch { return false; }
}

function check(root, repo, opts, env, deps) {
  if (!inIndex(root, env, deps)) return null;
  let limits;
  try {
    limits = readBaseline(deps.git(root, ['show', `:${BASELINE}`], { env }).replace(/^﻿/, ''));
  } catch (e) {
    return `${BASELINE} is not valid (${String(e.message ?? e).split('\n')[0]}). Regenerate it with node "${COMMENTS_SCRIPT}" baseline.`;
  }
  const only = opts.paths.length && !opts.include && !opts.all;
  let raw;
  try {
    raw = deps.git(repo, ['diff', '--cached', '--raw', '-z', '-M', '--no-color', ...(only ? ['--', ...opts.paths] : [])], { env });
  } catch (e) {
    return `bstack could not read the staged changes to check the comment baseline (${String(e.message ?? e).split('\n')[0]}). The check fails closed.`;
  }
  const changed = parseRaw(raw).filter(r => r.status !== 'D' && REGULAR.test(r.dstMode) && syntaxFor(r.path));
  if (!changed.length) return null;
  const counts = countBlobs(root, changed.map(r => ({ sha: r.dstSha, path: r.path })), deps);
  const over = changed.map((r, k) => ({ ...r, now: counts[k], base: Math.max(limits[r.path] ?? 0, r.from ? limits[r.from] ?? 0 : 0) }))
    .filter(r => r.now > r.base);
  const known = over.filter(r => !ZERO.test(r.srcSha) && REGULAR.test(r.srcMode));
  const before = countBlobs(root, known.map(r => ({ sha: r.srcSha, path: r.from ?? r.path })), deps);
  known.forEach((r, k) => { r.head = before[k]; });
  const refused = over.filter(r => r.now > (r.head ?? 0));
  return refused.length ? refusal(refused) : null;
}

function readBaseline(text) {
  const data = JSON.parse(text);
  const files = data?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('expected {"files": {"<path>": <comment lines>}}');
  for (const [file, n] of Object.entries(files)) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`${file}: ${JSON.stringify(n)} is not a count`);
  }
  return files;
}

function parseRaw(raw) {
  const parts = raw.split('\0');
  const out = [];
  for (let k = 0; k < parts.length;) {
    const head = parts[k++];
    if (!head.startsWith(':')) continue;
    const [srcMode, dstMode, srcSha, dstSha, status] = head.slice(1).split(' ');
    const kind = status[0];
    const first = parts[k++];
    const second = kind === 'R' || kind === 'C' ? parts[k++] : null;
    out.push({ srcMode, dstMode, srcSha, dstSha, status: kind, path: second ?? first, from: kind === 'R' ? first : null });
  }
  return out;
}

function countBlobs(root, blobs, deps) {
  if (!blobs.length) return [];
  const buf = deps.git(root, ['cat-file', '--batch'], { input: `${blobs.map(b => b.sha).join('\n')}\n`, buffer: true });
  const counts = [];
  let at = 0;
  for (const blob of blobs) {
    const eol = buf.indexOf(0x0a, at);
    const [, type, size] = buf.subarray(at, eol).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`git cat-file could not read ${blob.path}`);
    const body = buf.subarray(eol + 1, eol + 1 + Number(size));
    at = eol + 1 + Number(size) + 1;
    counts.push(countSource(blob.path, decodeSource(body))?.comments ?? 0);
  }
  return counts;
}

function refusal(files) {
  const lines = files.map(f => `  ${f.path}: baseline ${f.base}, this commit ${f.now}${f.head > f.base ? ` (${f.head} before it)` : ''}`);
  return [
    `This commit adds comment lines over ${BASELINE}:`,
    ...lines,
    'Remove them instead: rename or extract so the code says it, or encode the constraint as a test, type or runtime check.',
    `A comment about something outside this code (a third-party API, a browser or library bug) may stay, prefixed external: with proof; then run node "${COMMENTS_SCRIPT}" baseline and commit the new baseline with it.`,
    `After a cleanup, run the same command to lower the baseline.`,
  ].join('\n');
}
