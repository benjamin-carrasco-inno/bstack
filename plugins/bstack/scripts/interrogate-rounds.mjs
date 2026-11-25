#!/usr/bin/env node
// Reports per merged PR the interrogate rounds and findings, the reviewer runs and the hours from open to
// merge, so the round cap, the blocking rule and the cost of review can be judged on evidence.
// Usage: node interrogate-rounds.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo owner/name]...
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

export const reviewerRuns = comments => (comments ?? []).filter(c => shaOf('verdict', c.body)).length;

export const hoursOpen = pr => round1((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3600000);

export const prRow = pr => ({
  number: pr.number,
  title: pr.title,
  reviews: reviewerRuns(pr.comments),
  hours: hoursOpen(pr),
  ...prRounds(pr.comments),
});

const interrogated = r => r.rounds !== undefined;

export function summarize(rows) {
  const rounds = sum(rows, 'rounds');
  return {
    prs: rows.length,
    meanRounds: rows.length ? rounds / rows.length : 0,
    capShare: rows.length ? rows.filter(r => r.rounds >= INTERROGATE_ROUNDS).length / rows.length : 0,
    blockingPerRound: rounds ? sum(rows, 'blocking') / rounds : 0,
  };
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function reviewSummary(rows) {
  return {
    prs: rows.length,
    meanReviews: rows.length ? sum(rows, 'reviews') / rows.length : 0,
    medianHours: rows.length ? median(rows.map(r => r.hours)) : 0,
  };
}

const prLine = r => {
  const review = `reviews=${r.reviews ?? 0} hours=${r.hours ?? '?'}`;
  const findings = interrogated(r)
    ? `rounds=${r.rounds} confirmed=${r.confirmed} blocking=${r.blocking} non-blocking=${r.confirmed - r.blocking} ${review}`
    : `no interrogate ${review}`;
  return `#${r.number} ${findings}  ${String(r.title ?? '').slice(0, 60)}`;
};

export function report(rows) {
  if (!rows.length) return '0 PRs with interrogate in the range';
  const lines = rows.map(prLine);
  const r = reviewSummary(rows);
  lines.push(`${r.prs} merged PRs, mean ${round1(r.meanReviews)} reviewer runs, median ${round1(r.medianHours)} hours from open to merge`);
  const s = summarize(rows.filter(interrogated));
  lines.push(s.prs
    ? `${s.prs} PRs with interrogate, mean ${round1(s.meanRounds)} rounds, ${Math.round(s.capShare * 100)} % hit the ${INTERROGATE_ROUNDS}-round cap, ${round1(s.blockingPerRound)} blocking findings per round`
    : '0 PRs with interrogate in the range');
  return lines.join('\n');
}

const DAY = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

export function options(argv) {
  const get = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const day = (name, fallback) => {
    const v = get(name) ?? fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} needs a date like 2026-12-22`);
    return v;
  };
  const repos = argv.flatMap((a, i) => (a === '--repo' ? [argv[i + 1]] : []));
  if (repos.some(r => !/^[\w.-]+\/[\w.-]+$/.test(r ?? ''))) throw new Error('--repo needs owner/name');
  return { since: day('--since', isoDay(Date.now() - 28 * DAY)), until: day('--until', isoDay(Date.now())), repos: repos.length ? repos : [null] };
}

export function mergedPrs({ since, until, repo }) {
  const args = ['pr', 'list', '--state', 'merged', '--search', `merged:${since}..${until}`, '--limit', '1000', '--json', 'number,title,comments,createdAt,mergedAt'];
  if (repo) args.push('-R', repo);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 }));
}

function main() {
  const opts = options(process.argv.slice(2));
  for (const repo of opts.repos) {
    const rows = mergedPrs({ ...opts, repo }).map(prRow).sort((a, b) => a.number - b.number);
    console.log(`Merged ${opts.since}..${opts.until}${repo ? ` in ${repo}` : ''}`);
    console.log(report(rows));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`interrogate-rounds failed: ${e.message ?? e}`); process.exit(1); }
}
