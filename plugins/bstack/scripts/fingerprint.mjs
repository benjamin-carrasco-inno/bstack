#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(e.stderr || e.message).trim()}`);
  }
}

function entryState(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'deleted';
    throw e;
  }
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return `link:${sha256(fs.readlinkSync(file))}`;
  return sha256(fs.readFileSync(file));
}

export function fingerprint(dir = process.cwd()) {
  const root = git(dir, ['rev-parse', '--show-toplevel']).trim();
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const paths = [...new Set(listed)].sort();
  const lines = [`HEAD ${head}`, ...paths.map(p => `${entryState(path.join(root, p))} ${p}`)];
  const body = lines.join('\n') + '\n';
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
