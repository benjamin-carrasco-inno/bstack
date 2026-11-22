#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const isMissing = e => e.code === 'ENOENT' || e.code === 'ENOTDIR';

function runGit(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const failure = detail => new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(detail).trim()}`);
  if (res.error) throw failure(res.error.message);
  return { status: res.status, stdout: res.stdout, failure: () => failure(res.stderr || `exit ${res.status}`) };
}

function git(cwd, args) {
  const res = runGit(cwd, args);
  if (res.status !== 0) throw res.failure();
  return res.stdout;
}

function gitValueOrNull(cwd, args) {
  const res = runGit(cwd, args);
  if (res.status === 1) return null;
  if (res.status !== 0) throw res.failure();
  return res.stdout.trim();
}

function fileHash(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch (e) {
    if (isMissing(e)) return 'missing';
    throw e;
  }
}

function entryState(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (isMissing(e)) return 'deleted';
    throw e;
  }
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return `link:${sha256(fs.readlinkSync(file))}`;
  return sha256(fs.readFileSync(file));
}

function globalExcludesFile(root) {
  const configured = gitValueOrNull(root, ['config', '--path', '--get', 'core.excludesFile']);
  if (configured !== null) return path.resolve(root, configured);
  const configHome = process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/git` : '~/.config/git';
  return git(root, ['-c', `core.excludesFile=${configHome}/ignore`, 'config', '--path', '--get', 'core.excludesFile']).trim();
}

const isNestedRepo = dir => entryState(dir) === 'dir' && fs.existsSync(path.join(dir, '.git'));

function entryLines(root, file) {
  const full = path.join(root, file);
  if (!isNestedRepo(full)) return [`${entryState(full)} ${file}`];
  return [`repo ${file}`, ...checkoutLines(full).map(line => `  ${line}`)];
}

function checkoutLines(dir) {
  const root = git(dir, ['rev-parse', '--show-toplevel']).trim();
  const head = gitValueOrNull(root, ['rev-parse', '--verify', '-q', 'HEAD']) ?? 'unborn';
  const branch = gitValueOrNull(root, ['symbolic-ref', '-q', 'HEAD']) ?? 'detached';
  const infoExclude = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const index = git(root, ['ls-files', '-s', '-v', '-z']).split('\0').filter(Boolean);
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return [
    `HEAD ${head}`,
    `branch ${branch}`,
    `info/exclude ${fileHash(infoExclude)}`,
    `excludesFile ${fileHash(globalExcludesFile(root))}`,
    ...index.map(entry => `index ${entry}`),
    ...[...new Set(listed)].sort().flatMap(file => entryLines(root, file)),
  ];
}

export function fingerprint(dir = process.cwd()) {
  const body = checkoutLines(dir).join('\n') + '\n';
  return `${body}fingerprint: ${sha256(body)}\n`;
}

function main() {
  try {
    process.stdout.write(fingerprint(process.argv[2] ?? process.cwd()));
  } catch (e) {
    console.error(`fingerprint failed: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
