import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERROGATE_ROUNDS, commentBody } from '../plugins/bstack/scripts/lib/verdicts.mjs';
import { prRounds, report, summarize } from '../plugins/bstack/scripts/interrogate-rounds.mjs';

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

test('rounds are distinct head SHAs; findings add up per round', () => {
  const comments = [comment(sha('a'), 3, 1), chatter, comment(sha('b'), 2, 0)];
  assert.deepEqual(prRounds(comments), { rounds: 2, confirmed: 5, blocking: 1 });
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
