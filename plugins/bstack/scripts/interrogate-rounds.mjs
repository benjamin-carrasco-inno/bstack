#!/usr/bin/env node
// Reports how many interrogate rounds merged PRs took and how many findings blocked, so the 3-round cap
// and the blocking rule can be judged on evidence.
// Usage: node interrogate-rounds.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo owner/name]
// Default range: the last 28 days, in the current directory's repo. Read-only: it only runs `gh pr list`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERROGATE_ROUNDS, blockingRounds, latestFor, shaOf } from './lib/verdicts.mjs';

const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
const round1 = n => Number(n.toFixed(1));

export function prRounds(comments) {
  const heads = new Set((comments ?? []).map(c => shaOf('interrogate', c.body)).filter(Boolean));
  if (!heads.size) return null;
  const results = [...heads].map(head => latestFor('interrogate', comments, head));
  return { rounds: blockingRounds(comments), confirmed: sum(results, 'confirmed'), blocking: sum(results, 'blocking') };
}

export function summarize(rows) {
  const rounds = sum(rows, 'rounds');
  return {
    prs: rows.length,
    meanRounds: rows.length ? rounds / rows.length : 0,
    capShare: rows.length ? rows.filter(r => r.rounds >= INTERROGATE_ROUNDS).length / rows.length : 0,
    blockingPerRound: rounds ? sum(rows, 'blocking') / rounds : 0,
  };
}

export function report(rows) {
  if (!rows.length) return '0 PRs with interrogate in the range';
  const s = summarize(rows);
  const lines = rows.map(r => `#${r.number} rounds=${r.rounds} confirmed=${r.confirmed} blocking=${r.blocking} non-blocking=${r.confirmed - r.blocking}  ${String(r.title ?? '').slice(0, 60)}`);
  lines.push(`${s.prs} PRs with interrogate, mean ${round1(s.meanRounds)} rounds, ${Math.round(s.capShare * 100)} % hit the ${INTERROGATE_ROUNDS}-round cap, ${round1(s.blockingPerRound)} blocking findings per round`);
  return lines.join('\n');
}

const DAY = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

function options(argv) {
  const get = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const day = (name, fallback) => {
    const v = get(name) ?? fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} needs a date like 2026-12-22`);
    return v;
  };
  return { since: day('--since', isoDay(Date.now() - 28 * DAY)), until: day('--until', isoDay(Date.now())), repo: get('--repo') };
}

export function mergedPrs({ since, until, repo }) {
  const args = ['pr', 'list', '--state', 'merged', '--search', `merged:${since}..${until}`, '--limit', '1000', '--json', 'number,title,comments'];
  if (repo) args.push('-R', repo);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 }));
}

function main() {
  const opts = options(process.argv.slice(2));
  const rows = mergedPrs(opts)
    .flatMap(pr => {
      const interrogated = prRounds(pr.comments);
      return interrogated ? [{ number: pr.number, title: pr.title, ...interrogated }] : [];
    })
    .sort((a, b) => a.number - b.number);
  console.log(`Merged ${opts.since}..${opts.until}${opts.repo ? ` in ${opts.repo}` : ''}`);
  console.log(report(rows));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`interrogate-rounds failed: ${e.message ?? e}`); process.exit(1); }
}
