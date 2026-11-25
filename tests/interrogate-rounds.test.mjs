import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERROGATE_ROUNDS, commentBody } from '../plugins/bstack/scripts/lib/verdicts.mjs';
import { hoursOpen, options, prRounds, prRow, report, reviewerRuns, summarize } from '../plugins/bstack/scripts/interrogate-rounds.mjs';

const sha = c => c.repeat(40);
const comment = (head, confirmed, blocking, createdAt = '2026-11-22T10:00:00Z') => ({
  body: commentBody('interrogate', { confirmed, blocking }, head, 'details'),
  createdAt,
});
const legacy = (head, confirmed) => ({
  body: `<!-- bstack-interrogate v1 -->\nbstack-interrogate: confirmed=${confirmed} sha=${head}\n\ndetails\n`,
  createdAt: '2026-11-22T10:00:00Z',
});
const chatter = { body: 'LGTM, ship it', createdAt: '2026-11-22T09:00:00Z' };

test('a PR without interrogate comments has no rounds', () => {
  assert.equal(prRounds([chatter]), null);
  assert.equal(prRounds([]), null);
  assert.equal(prRounds(undefined), null);
});

test('rounds are distinct blocking head SHAs; findings add up over every head', () => {
  const comments = [comment(sha('a'), 3, 1), chatter, comment(sha('b'), 2, 0)];
  assert.deepEqual(prRounds(comments), { rounds: 1, confirmed: 5, blocking: 1 });
});

test('two comments for the same head count one round, the newest wins', () => {
  const comments = [comment(sha('a'), 4, 4, '2026-11-22T10:00:00Z'), comment(sha('a'), 1, 0, '2026-11-22T11:00:00Z')];
  assert.deepEqual(prRounds(comments), { rounds: 1, confirmed: 1, blocking: 0 });
});

test('an old comment without blocking= counts every confirmed finding as blocking', () => {
  assert.deepEqual(prRounds([legacy(sha('a'), 2)]), { rounds: 1, confirmed: 2, blocking: 2 });
});

test('summary: PRs, mean rounds, cap share, blocking per round', () => {
  const rows = [
    { number: 1, rounds: 1, confirmed: 0, blocking: 0 },
    { number: 2, rounds: 3, confirmed: 5, blocking: 3 },
    { number: 3, rounds: 2, confirmed: 2, blocking: 1 },
    { number: 4, rounds: 2, confirmed: 1, blocking: 0 },
  ];
  assert.deepEqual(summarize(rows), { prs: 4, meanRounds: 2, capShare: 0.25, blockingPerRound: 0.5 });
});

test('the cap is the one the guard enforces', () => {
  assert.equal(INTERROGATE_ROUNDS, 3);
  assert.equal(summarize([{ number: 1, rounds: INTERROGATE_ROUNDS, confirmed: 0, blocking: 0 }]).capShare, 1);
});

test('only heads with blocking findings count toward the cap, as in the guard', () => {
  const clean = prRounds([comment(sha('a'), 0, 0), comment(sha('b'), 2, 0), comment(sha('c'), 1, 0)]);
  assert.deepEqual(clean, { rounds: 0, confirmed: 3, blocking: 0 });
  assert.equal(summarize([{ number: 1, ...clean }]).capShare, 0);
  const blocked = prRounds([comment(sha('a'), 1, 1), comment(sha('b'), 2, 1), comment(sha('c'), 1, 1)]);
  assert.deepEqual(blocked, { rounds: INTERROGATE_ROUNDS, confirmed: 4, blocking: 3 });
  assert.equal(summarize([{ number: 1, ...blocked }]).capShare, 1);
});

test('summary of nothing does not divide by zero', () => {
  assert.deepEqual(summarize([]), { prs: 0, meanRounds: 0, capShare: 0, blockingPerRound: 0 });
});

test('report lists each PR, then the summary line', () => {
  const rows = [
    { number: 12, title: 'feat: x', rounds: 2, confirmed: 3, blocking: 1 },
    { number: 9, title: 'fix: y', rounds: 3, confirmed: 2, blocking: 2 },
  ];
  const lines = report(rows).split('\n');
  assert.match(lines[0], /#12\b.*rounds=2.*confirmed=3.*blocking=1.*non-blocking=2/);
  assert.match(lines[1], /#9\b.*rounds=3.*confirmed=2.*blocking=2.*non-blocking=0/);
  assert.match(lines.at(-1), /2 PRs with interrogate, mean 2\.5 rounds, 50 % hit the 3-round cap, 0\.6 blocking findings per round/);
});

test('report with no interrogate PRs says so', () => {
  assert.equal(report([]), '0 PRs with interrogate in the range');
});

const verdict = (head, result = 'PASS') => ({ body: commentBody('verdict', result, head, 'details'), createdAt: '2026-11-22T12:00:00Z' });
const pr = (number, comments, createdAt = '2026-11-22T08:00:00Z', mergedAt = '2026-11-22T11:30:00Z') => ({ number, title: `PR ${number}`, comments, createdAt, mergedAt });

test('reviewer runs count every verdict comment, one per run, not interrogate or chatter', () => {
  assert.equal(reviewerRuns([verdict(sha('a')), verdict(sha('a'), 'FAIL'), verdict(sha('b')), comment(sha('b'), 1, 0), chatter]), 3);
  assert.equal(reviewerRuns(undefined), 0);
});

test('hours from open to merge, to one decimal', () => {
  assert.equal(hoursOpen(pr(1, [])), 3.5);
  assert.equal(hoursOpen(pr(1, [], '2026-11-22T08:00:00Z', '2026-11-24T08:06:00Z')), 48.1);
});

test('every merged PR gets a row, with interrogate fields only when it was interrogated', () => {
  assert.deepEqual(prRow(pr(5, [verdict(sha('a')), chatter])), { number: 5, title: 'PR 5', reviews: 1, hours: 3.5 });
  assert.deepEqual(prRow(pr(6, [comment(sha('a'), 2, 1), verdict(sha('b')), verdict(sha('c'))])),
    { number: 6, title: 'PR 6', reviews: 2, hours: 3.5, rounds: 1, confirmed: 2, blocking: 1 });
});

test('report: reviewer runs and hours per PR, a review summary, and interrogate summed over interrogated PRs only', () => {
  const rows = [
    prRow(pr(5, [verdict(sha('a'))])),
    prRow(pr(6, [comment(sha('a'), 2, 1), verdict(sha('b')), verdict(sha('c'))], '2026-11-22T08:00:00Z', '2026-11-22T09:00:00Z')),
  ];
  const lines = report(rows).split('\n');
  assert.match(lines[0], /^#5 no interrogate reviews=1 hours=3\.5 /);
  assert.match(lines[1], /^#6 rounds=1 confirmed=2 blocking=1 non-blocking=1 reviews=2 hours=1 /);
  assert.equal(lines[2], '2 merged PRs, mean 1.5 reviewer runs, median 2.3 hours from open to merge');
  assert.equal(lines[3], '1 PRs with interrogate, mean 1 rounds, 0 % hit the 3-round cap, 1 blocking findings per round');
  assert.equal(report([prRow(pr(5, []))]).split('\n').at(-1), '0 PRs with interrogate in the range');
});

test('--repo can be given several times; none means the current repo; a malformed one stops', () => {
  assert.deepEqual(options(['--repo', 'o/a', '--since', '2026-11-01', '--repo', 'o/b']).repos, ['o/a', 'o/b']);
  assert.deepEqual(options([]).repos, [null]);
  assert.throws(() => options(['--repo']), /--repo needs owner\/name/);
  assert.throws(() => options(['--repo', '--since', '2026-11-01']), /--repo needs owner\/name/);
});
