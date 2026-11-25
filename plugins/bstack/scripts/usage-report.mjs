#!/usr/bin/env node
// Reports where the tokens go: weighted tokens by repo, role, model, effort and branch, read from the
// Claude Code transcripts (`projects/**/*.jsonl`, subagents included) under each config dir. Read-only.
// Usage: node usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [configDir...]
// Default: the last 7 days (UTC, both ends inclusive), from $CLAUDE_CONFIG_DIR, else ~/.claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Relative to one input token, at list price.
export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const PARTS = { input: 'input', cacheWrite: 'cache write', cacheRead: 'cache read', output: 'output' };

export const weighted = u => Object.keys(WEIGHTS).reduce((n, k) => n + WEIGHTS[k] * u[k], 0);
export const contextOf = u => u.input + u.cacheWrite + u.cacheRead;

// The repo a session works in, from its start directory: <repo>/.claude/worktrees/<agent>,
// .t3/worktrees/<repo>/<lane>, or the directory itself.
export function repoOf(cwd) {
  const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean);
  const worktrees = parts.lastIndexOf('worktrees');
  if (worktrees > 0 && parts[worktrees - 1] === '.claude') return parts[worktrees - 2] ?? '?';
  if (worktrees > 0 && parts[worktrees - 1] === '.t3') return parts[worktrees + 1] ?? '?';
  return parts.at(-1) ?? '?';
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : e.name.endsWith('.jsonl') ? [p] : [];
});

const agentTypeOf = file => {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? null; } catch { return null; }
};

const usageOf = u => ({
  input: u.input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  output: u.output_tokens ?? 0,
});

// One request per API call. A transcript writes one line per content block of a response, each with
// the full usage of that request, so lines are keyed by requestId and counted once.
export async function readRequests({ configDirs, since, until }) {
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`) + 86400000;
  const seen = new Set();
  const requests = [];
  const files = configDirs.map(d => path.join(d, 'projects')).filter(d => fs.existsSync(d)).flatMap(walk)
    .filter(f => fs.statSync(f).mtimeMs >= from);
  for (const file of files) {
    let repo = null;
    const agentType = agentTypeOf(file);
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      repo ??= o.cwd ? repoOf(o.cwd) : null;
      const m = o.message;
      if (o.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
      const at = Date.parse(o.timestamp);
      const id = o.requestId ?? m.id ?? o.uuid;
      if (!(at >= from && at < to) || seen.has(id)) continue;
      seen.add(id);
      requests.push({
        repo: repo ?? '?',
        branch: o.gitBranch || '?',
        role: o.isSidechain ? o.attributionAgent ?? agentType ?? 'subagent' : 'main',
        model: String(m.model ?? '?').replace(/^claude-/, ''),
        effort: o.effort ?? '-',
        usage: usageOf(m.usage),
      });
    }
  }
  return { files: files.length, requests };
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function group(requests, keyOf) {
  const groups = new Map();
  for (const r of requests) {
    const key = keyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].map(([key, rs]) => ({
    key,
    weighted: rs.reduce((n, r) => n + weighted(r.usage), 0),
    requests: rs.length,
    medianContext: median(rs.map(r => contextOf(r.usage))),
  })).sort((a, b) => b.weighted - a.weighted);
}

const M = n => `${(n / 1e6).toFixed(2)}M`;
const pct = (n, total) => `${total ? Math.round((100 * n) / total) : 0} %`;

const DIMENSIONS = [
  ['repo', r => r.repo],
  ['role', r => r.role],
  ['model', r => r.model],
  ['effort', r => r.effort],
  ['branch', r => `${r.repo} ${r.branch}`],
];

export function report({ files, requests }) {
  const total = requests.reduce((n, r) => n + weighted(r.usage), 0);
  const part = k => requests.reduce((n, r) => n + WEIGHTS[k] * r.usage[k], 0);
  const lines = [
    `${requests.length} requests in ${files} transcript files, weighted total ${M(total)}`,
    `Weights per token: ${Object.keys(WEIGHTS).map(k => `${PARTS[k]} ${WEIGHTS[k]}`).join(', ')}`,
    `Weighted split: ${Object.keys(WEIGHTS).map(k => `${PARTS[k]} ${pct(part(k), total)}`).join(', ')}`,
  ];
  for (const [name, keyOf] of DIMENSIONS) {
    lines.push('', `By ${name}: weighted tokens, share, requests, median context per request`);
    const groups = group(requests, keyOf);
    const width = Math.max(0, ...groups.map(g => g.key.length));
    for (const g of groups) {
      lines.push(`  ${g.key.padEnd(width)}${M(g.weighted).padStart(8)} ${pct(g.weighted, total).padStart(5)} ${String(g.requests).padStart(6)} ${`${Math.round(g.medianContext / 1000)}k`.padStart(6)}`);
    }
  }
  return lines.join('\n');
}

const DAY = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

export function options(argv) {
  const args = [...argv];
  const take = name => {
    const i = args.indexOf(name);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const day = (name, fallback) => {
    const v = take(name) ?? fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '')) throw new Error(`${name} needs a date like 2026-12-22`);
    return v;
  };
  const since = day('--since', isoDay(Date.now() - 6 * DAY));
  const until = day('--until', isoDay(Date.now()));
  const unknown = args.find(a => a.startsWith('--'));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  const configDirs = args.length ? args : [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')];
  return { since, until, configDirs };
}

async function main() {
  const opts = options(process.argv.slice(2));
  console.log(`Usage ${opts.since}..${opts.until} from ${opts.configDirs.join(', ')}`);
  console.log(report(await readRequests(opts)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`usage-report failed: ${e.message ?? e}`); process.exit(1); });
}
