#!/usr/bin/env node
// Reports per repo how often a merged code PR needed a follow-up: it was reverted, or a later fix names
// it ("#12") because it repaired what that PR broke or missed. A rising share means the gates need work.
// The ship playbook asks every fix PR to name the PR it repairs, so this stays current without upkeep.
// Usage: node merge-quality.mjs [--days 30] [repo-dir ...]   (default: the current directory)
// Read-only apart from git fetch.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const daysAt = args.indexOf('--days');
const days = daysAt < 0 ? 30 : Number(args.splice(daysAt, 2)[1]);
const repos = (args.length ? args : ['.']).map(a => path.resolve(a));

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const CODE = /^(feat|fix|refactor|perf)(\(|!|:)/i;

for (const repo of repos) {
  const name = path.basename(repo);
  try { git(repo, 'fetch', '-q', '--prune'); } catch { console.error(`${name}: fetch failed, using the local copy`); }
  const branch = ['origin/HEAD', 'origin/main', 'origin/master'].find(ref => {
    try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
  });
  if (!branch) { console.log(`${name}: no origin default branch, skipped`); continue; }
  const raw = git(repo, 'log', branch, '--first-parent', `--since=${days} days ago`, '--reverse', '--format=%x1e%h%x1f%s%x1f%b');
  const commits = raw.split('\x1e').filter(Boolean).map(block => {
    const [hash, subject, body] = block.split('\x1f');
    return { hash, subject, body: body ?? '', pr: Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1]) || null };
  });
  const code = commits.filter(c => CODE.test(c.subject) && c.pr);
  const followed = new Map();
  for (const c of commits) {
    const isRevert = /^revert/i.test(c.subject);
    if (!isRevert && !/^fix(\(|!|:)/i.test(c.subject)) continue;
    const named = new Set([...`${c.subject}\n${c.body}`.matchAll(/#(\d+)\b/g)].map(m => Number(m[1])));
    named.delete(c.pr);
    for (const t of code) {
      if (t !== c && named.has(t.pr) && !followed.has(t.hash)) followed.set(t.hash, `${isRevert ? 'reverted' : 'fixed'} by ${c.hash} ${c.subject}`);
    }
  }
  const share = code.length ? Math.round((followed.size / code.length) * 100) : 0;
  console.log(`${name}: ${code.length} code PRs in ${days} days, ${followed.size} needed a follow-up (${share} %)`);
  for (const [hash, why] of followed) {
    const t = code.find(c => c.hash === hash);
    console.log(`  ${hash} ${t.subject.slice(0, 70)}  ->  ${why.slice(0, 90)}`);
  }
}
