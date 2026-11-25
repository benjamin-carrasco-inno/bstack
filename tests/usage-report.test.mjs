import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEIGHTS, group, options, readRequests, repoOf, report, weighted } from '../plugins/bstack/scripts/usage-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'usage-report');
const script = path.join(here, '..', 'plugins', 'bstack', 'scripts', 'usage-report.mjs');
const range = { configDirs: [fixture], since: '2026-11-21', until: '2026-11-25' };

test('the weights are list price relative to one input token', () => {
  assert.deepEqual(WEIGHTS, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
  assert.equal(weighted({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 20 }), 335);
});

test('the repo comes from the start directory, worktrees included', () => {
  assert.equal(repoOf('C:\\work\\shop'), 'shop');
  assert.equal(repoOf('/home/u/src/shop/.claude/worktrees/agent-a1'), 'shop');
  assert.equal(repoOf('C:\\Users\\x\\.t3\\worktrees\\shop\\lane-1'), 'shop');
  assert.equal(repoOf(''), '?');
});

test('a request written as several content-block lines counts once; synthetic, broken and out-of-range lines do not count', async () => {
  const { files, requests } = await readRequests(range);
  assert.equal(files, 3);
  assert.equal(requests.length, 5);
  assert.equal(requests.reduce((n, r) => n + weighted(r.usage), 0), 335 + 250 + 5 + 134.5 + 6);
});

test('role is main, the attributed agent, or the agent type from the subagent meta file', async () => {
  const { requests } = await readRequests(range);
  const roles = group(requests, r => r.role).map(g => [g.key, g.requests]);
  assert.deepEqual(roles, [['main', 3], ['bstack:reviewer', 1], ['bstack:adversary', 1]]);
  assert.deepEqual(new Set(requests.map(r => r.repo)), new Set(['shop']));
});

test('per branch: weighted tokens, requests and median context per request', async () => {
  const { requests } = await readRequests(range);
  const branches = Object.fromEntries(group(requests, r => r.branch).map(g => [g.key, g]));
  assert.deepEqual(branches['feat/x'], { key: 'feat/x', weighted: 340, requests: 2, medianContext: (1110 + 5) / 2 });
  assert.deepEqual(branches.main, { key: 'main', weighted: 250, requests: 1, medianContext: 2000 });
  assert.equal(branches.HEAD.requests, 2);
});

test('the until day is inclusive and the since day bounds the start', async () => {
  assert.equal((await readRequests({ ...range, until: '2026-11-24' })).requests.length, 4);
  assert.equal((await readRequests({ ...range, since: '2026-11-25' })).requests.length, 1);
});

test('a config dir without transcripts reports zero', async () => {
  const empty = await readRequests({ ...range, configDirs: [path.join(fixture, 'missing')] });
  assert.deepEqual(empty, { files: 0, requests: [] });
  assert.match(report(empty), /^0 requests in 0 transcript files, weighted total 0\.00M/);
});

test('the CLI names the weights and prints every breakdown', () => {
  const out = execFileSync(process.execPath, [script, '--since', '2026-11-21', '--until', '2026-11-25', fixture], { encoding: 'utf8' });
  assert.match(out, /^5 requests in 3 transcript files, weighted total 0\.00M$/m);
  assert.match(out, /^Weights per token: input 1, cache write 1\.25, cache read 0\.1, output 5$/m);
  for (const by of ['repo', 'role', 'model', 'effort', 'branch']) assert.match(out, new RegExp(`^By ${by}: `, 'm'));
  assert.match(out, /^ {2}shop feat\/x +0\.00M +47 % +2 +1k$/m);
});

test('a bad date or an unknown option stops with an error', () => {
  assert.throws(() => options(['--since', '25-11-2026']), /--since needs a date/);
  assert.throws(() => options(['--repo', 'x']), /unknown option --repo/);
  const run = spawnSync(process.execPath, [script, '--until', 'yesterday'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage-report failed: --until needs a date/);
});
