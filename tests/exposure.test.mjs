import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../plugins/bstack/scripts/guard.mjs';
import { commentBody } from '../plugins/bstack/scripts/lib/verdicts.mjs';
import { exposureOf, gatePlan } from '../plugins/bstack/scripts/risk-tier.mjs';

const SCRIPT = fileURLToPath(new URL('../plugins/bstack/scripts/risk-tier.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
const EARLIER = 'c'.repeat(40);
const FIRST = 'e'.repeat(40);
const FOREIGN = 'd'.repeat(40);
const GREEN = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const DATA_DIFF = 'diff --git a/app/db.py b/app/db.py\n--- a/app/db.py\n+++ b/app/db.py\n+conn.execute("DELETE FROM orders")\n';
const fileDiff = (p, line) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n+${line}\n`;
const EXPOSURE_ON_HEAD = fileDiff('.github/bstack-exposure.txt', 'internal') + DATA_DIFF;
const RISK_PATHS_CHANGED = fileDiff('.github/risk-paths.txt', 'docs/**') + DATA_DIFF;

const at = minute => `2026-11-25T10:${String(minute).padStart(2, '0')}:00Z`;
const OWN = { viewerDidAuthor: true };
const verdict = (sha, minute, result = 'PASS') => ({ body: commentBody('verdict', result, sha, 'report'), createdAt: at(minute), ...OWN });
const interrogate = (sha, minute, blocking = 0) => ({ body: commentBody('interrogate', { confirmed: blocking, blocking }, sha, 'report'), createdAt: at(minute), ...OWN });
const userOk = (sha, minute) => ({ body: `Merge it.\nbstack-user-ok sha=${sha}\n`, createdAt: at(minute), ...OWN });

const POLICY = /^repos\/([\w.-]+\/[\w.-]+)\/contents\/\.github\/(risk-paths|bstack-exposure)\.txt\?ref=(.+)$/;
const notFound = () => { throw new Error('gh: Not Found (HTTP 404)'); };

// policy: { 'o/r': { exposure, riskPaths } }, a value that is a function throws.
function github({ policy = {}, diff = DATA_DIFF, comments = [], commits = [FIRST, EARLIER, HEAD], pr = {}, failCommits = false } = {}) {
  const calls = [];
  const deps = {
    git: () => { throw new Error('no git'); },
    readFile: () => null,
    insideBstackSource: () => false,
    pending: { list: () => [], remove: () => {} },
    postComment: () => { throw new Error('unexpected comment'); },
    gh: (_cwd, args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ number: 5, url: 'https://github.com/o/r/pull/5', headRefOid: HEAD, baseRefName: 'main', state: 'OPEN', statusCheckRollup: GREEN, comments, ...pr });
      if (args[1] === 'diff') return diff;
      const endpoint = args.find(a => String(a).startsWith('repos/')) ?? '';
      const read = POLICY.exec(endpoint);
      if (read) {
        const value = policy[read[1]]?.[read[2] === 'risk-paths' ? 'riskPaths' : 'exposure'];
        if (typeof value === 'function') return value();
        return value ?? notFound();
      }
      if (/\/pulls\/\d+\/commits/.test(endpoint)) {
        if (failCommits) throw new Error('HTTP 502: bad gateway');
        return commits.map(s => `${s} ${'f'.repeat(40)}`).join('\n');
      }
      return notFound();
    },
  };
  return { deps, calls };
}

const merge = (g, command = 'gh pr merge 5 --squash') => decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' }, g.deps);
const internal = { 'o/r': { exposure: 'internal\n' } };
const HEAD_INTERROGATE = /run bstack:interrogate on head aaaaaaa/;

test('internal tier 2 merges with a verdict for the head and an interrogate result for the head', () => {
  assert.equal(merge(github({ policy: internal, comments: [verdict(HEAD, 1), interrogate(HEAD, 2)] })), null);
});

test('internal tier 2 accepts an interrogate result for an earlier commit of the same PR', () => {
  assert.equal(merge(github({ policy: internal, comments: [interrogate(EARLIER, 1), verdict(HEAD, 2)] })), null);
});

test('internal tier 2 refuses an interrogate result for a commit outside the PR', () => {
  assert.match(merge(github({ policy: internal, comments: [interrogate(FOREIGN, 1), verdict(HEAD, 2)] })) ?? '', /interrogate/);
});

test('internal tier 2 still needs a verdict for the head and an interrogate result', () => {
  assert.match(merge(github({ policy: internal, comments: [interrogate(HEAD, 1)] })) ?? '', /no reviewer verdict/);
  assert.match(merge(github({ policy: internal, comments: [verdict(HEAD, 1)] })) ?? '', /interrogate/);
});

test('internal tier 2 with blocking findings needs them on an earlier commit and a newer verdict', () => {
  assert.equal(merge(github({ policy: internal, comments: [interrogate(EARLIER, 1, 2), verdict(HEAD, 2)] })), null);
  assert.match(merge(github({ policy: internal, comments: [verdict(HEAD, 1), interrogate(EARLIER, 2, 2)] })) ?? '', /blocking/);
  assert.match(merge(github({ policy: internal, comments: [verdict(HEAD, 1), interrogate(HEAD, 2, 1)] })) ?? '', /blocking/);
  assert.match(merge(github({ policy: internal, comments: [interrogate(HEAD, 1, 1), verdict(HEAD, 2)] })) ?? '', /blocking/);
});

test('internal tier 2 judges the newest interrogate result, not an older clean one', () => {
  assert.match(merge(github({ policy: internal, comments: [interrogate(FIRST, 1), verdict(HEAD, 2), interrogate(EARLIER, 3, 1)] })) ?? '', /blocking/);
  assert.equal(merge(github({ policy: internal, comments: [interrogate(FIRST, 1, 1), interrogate(EARLIER, 2), verdict(HEAD, 3)] })), null);
});

test('internal tier 2 fails closed when the commits of the PR cannot be read', () => {
  assert.match(merge(github({ policy: internal, failCommits: true, comments: [interrogate(EARLIER, 1), verdict(HEAD, 2)] })) ?? '', /could not read the commits/);
});

test('any exposure value other than exactly internal takes the external flow', () => {
  const comments = [interrogate(EARLIER, 1), verdict(HEAD, 2)];
  for (const value of ['', 'external\n', 'Internal\n', 'internal junk\n', 'internal # note\n', 'internal\ninternal\n', 'internal\nexternal\n', 'internally\n']) {
    assert.match(merge(github({ policy: { 'o/r': { exposure: value } }, comments })) ?? '', HEAD_INTERROGATE, JSON.stringify(value));
  }
  for (const value of ['internal', '  internal  \r\n', '# exposure of this repo\n\ninternal\n']) {
    assert.equal(merge(github({ policy: { 'o/r': { exposure: value } }, comments })), null, JSON.stringify(value));
  }
});

test('a missing exposure file is external and an unreadable one fails closed', () => {
  assert.match(merge(github({ comments: [interrogate(EARLIER, 1), verdict(HEAD, 2)] })) ?? '', HEAD_INTERROGATE);
  const unreadable = { 'o/r': { exposure: () => { throw new Error('gh: Server Error (HTTP 502)'); } } };
  assert.match(merge(github({ policy: unreadable, comments: [verdict(HEAD, 1), interrogate(HEAD, 2)] })) ?? '', /could not read \.github\/bstack-exposure\.txt from main in o\/r/);
});

test('external tier 2 is unchanged: an interrogate result for the head', () => {
  assert.equal(merge(github({ comments: [verdict(HEAD, 1), interrogate(HEAD, 2)] })), null);
  assert.match(merge(github({ comments: [interrogate(HEAD, 1, 1), verdict(HEAD, 2)] })) ?? '', /blocking/);
});

test('a path listed in risk-paths.txt takes the external flow in an internal repo', () => {
  const policy = { 'o/r': { exposure: 'internal\n', riskPaths: 'app/db.py\n' } };
  assert.match(merge(github({ policy, comments: [interrogate(EARLIER, 1), verdict(HEAD, 2)] })) ?? '', HEAD_INTERROGATE);
  assert.equal(merge(github({ policy, comments: [verdict(HEAD, 1), interrogate(HEAD, 2)] })), null);
});

test('an exposure file only on the PR head is never read: the base decides', () => {
  const g = github({ diff: EXPOSURE_ON_HEAD, comments: [interrogate(EARLIER, 1), verdict(HEAD, 2), userOk(HEAD, 3)] });
  assert.match(merge(g) ?? '', HEAD_INTERROGATE);
  const reads = g.calls.map(a => a.at(-1)).filter(e => /bstack-exposure/.test(e));
  assert.deepEqual(reads, ['repos/o/r/contents/.github/bstack-exposure.txt?ref=main']);
});

test('a PR that changes a policy file takes the external flow and needs the owner OK for the head', () => {
  for (const diff of [EXPOSURE_ON_HEAD, RISK_PATHS_CHANGED]) {
    for (const policy of [{}, internal]) {
      const clean = [verdict(HEAD, 1), interrogate(HEAD, 2)];
      assert.match(merge(github({ policy, diff, comments: [interrogate(EARLIER, 1), verdict(HEAD, 2), userOk(HEAD, 3)] })) ?? '', HEAD_INTERROGATE);
      assert.match(merge(github({ policy, diff, comments: clean })) ?? '', /bstack-user-ok sha=a{40}/);
      assert.match(merge(github({ policy, diff, comments: [...clean, userOk(EARLIER, 3)] })) ?? '', /bstack-user-ok sha=a{40}/);
      assert.equal(merge(github({ policy, diff, comments: [...clean, userOk(HEAD, 3)] })), null);
    }
  }
});

test('the exposure comes from the repo the merge names, not the checkout', () => {
  const pr = { number: 7, url: 'https://github.com/x/y/pull/7', baseRefName: 'release/1.0' };
  const comments = [interrogate(EARLIER, 1), verdict(HEAD, 2)];
  const other = github({ policy: internal, pr, comments });
  assert.match(merge(other, 'gh pr merge 7 -R x/y --squash') ?? '', HEAD_INTERROGATE);
  assert.ok(other.calls.some(a => a.at(-1) === 'repos/x/y/contents/.github/bstack-exposure.txt?ref=release%2F1.0'), JSON.stringify(other.calls));
  assert.ok(!other.calls.some(a => String(a.at(-1)).startsWith('repos/o/r/')), JSON.stringify(other.calls));
  assert.equal(merge(github({ policy: { 'x/y': { exposure: 'internal' } }, pr, comments }), 'gh pr merge 7 -R x/y --squash'), null);
});

test('exposureOf reads exactly one internal line, everything else is external', () => {
  assert.equal(exposureOf('internal\n'), 'internal');
  assert.equal(exposureOf('# note\n\n internal \n'), 'internal');
  for (const v of [undefined, '', 'external', 'internal x', 'internal\ninternal', 'INTERNAL']) assert.equal(exposureOf(v), 'external', String(v));
});

test('gatePlan lists the steps the gate requires per tier and exposure', () => {
  const external = gatePlan(DATA_DIFF, 2, { exposure: 'external' });
  const plain = gatePlan(DATA_DIFF, 2, { exposure: 'internal' });
  assert.equal(external.flow, 'external');
  assert.equal(plain.flow, 'internal');
  assert.notDeepEqual(external.steps, plain.steps);
  assert.ok(gatePlan(DATA_DIFF, 2, { exposure: 'internal', extraPaths: ['app/**'] }).flow === 'external');
  const policy = gatePlan(EXPOSURE_ON_HEAD, 2, { exposure: 'internal' });
  assert.equal(policy.flow, 'external');
  assert.ok(policy.steps.some(s => /bstack-user-ok/.test(s)), policy.steps.join('; '));
  assert.deepEqual(gatePlan(DATA_DIFF, 1, { exposure: 'internal' }).steps, gatePlan(DATA_DIFF, 1, { exposure: 'external' }).steps);
  assert.deepEqual(gatePlan('', 0).steps, ['CI green']);
});

test('risk-tier.mjs prints the exposure of the base ref and the steps the gate requires', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-exposure-cli-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  const cli = () => JSON.parse(execFileSync(process.execPath, [SCRIPT, '--base', 'main'], { cwd: repo, encoding: 'utf8' }));
  try {
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'app'));
    fs.writeFileSync(path.join(repo, 'app', 'db.py'), 'x = 0\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(repo, 'app', 'db.py'), 'conn.execute("DELETE FROM orders")\n');
    const external = cli();
    assert.equal(external.exposure, 'external');
    assert.equal(external.tier, 2);
    assert.ok(external.steps.length > 2, external.steps.join('; '));
    git('checkout', '-q', 'main');
    fs.mkdirSync(path.join(repo, '.github'));
    fs.writeFileSync(path.join(repo, '.github', 'bstack-exposure.txt'), 'internal\n');
    git('add', '.github');
    git('commit', '-q', '-m', 'internal');
    git('checkout', '-q', 'feat');
    git('merge', '-q', 'main');
    const plain = cli();
    assert.equal(plain.exposure, 'internal');
    assert.equal(plain.flow, 'internal');
    assert.notDeepEqual(plain.steps, external.steps);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
