import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLabels, frontier, parseArgs, LABELS } from '../plugins/bstack/scripts/tracker.mjs';

// A fake gh that answers from a table of issues and records every call.
function fakeGh({ labels = [], issues = {}, parent = null } = {}) {
  const calls = [];
  const gh = args => {
    calls.push(args);
    const [group, action, ref] = args;
    if (group === 'label' && action === 'list') return JSON.stringify(labels.map(name => ({ name })));
    if (group === 'label' && action === 'create') return '';
    if (group === 'issue' && action === 'view' && parent && Number(ref) === parent.number) return JSON.stringify(parent);
    if (group === 'issue' && action === 'view') return JSON.stringify(issues[ref]);
    if (group === 'issue' && action === 'list') {
      return JSON.stringify(Object.values(issues).filter(i => i.state === 'OPEN' && i.labels.some(l => l.name === 'ready-for-agent')).map(i => ({ number: i.number, createdAt: i.createdAt })));
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

const issue = (number, { state = 'OPEN', labels = [], assignees = [], blockedBy = [], createdAt = '2026-11-01T00:00:00Z' } = {}) => ({
  number, title: `ticket ${number}`, url: `https://github.com/o/r/issues/${number}`, state, createdAt,
  labels: labels.map(name => ({ name })), assignees: assignees.map(login => ({ login })),
  blockedBy: { nodes: blockedBy.map(([n, s]) => ({ number: n, state: s })), totalCount: blockedBy.length },
});

test('labels creates only the missing ones, case-insensitively, and touches nothing else', () => {
  const { gh, calls } = fakeGh({ labels: ['bug', 'Enhancement', 'wontfix', 'plan:map', 'custom'] });
  const out = ensureLabels(gh, 'o/r');
  const created = calls.filter(c => c[1] === 'create').map(c => c[2]);
  assert.deepEqual(out.created, created);
  assert.equal(created.length, LABELS.length - 4);
  assert.ok(!created.includes('bug') && !created.includes('enhancement') && !created.includes('plan:map'));
  assert.ok(calls.every(c => c[1] === 'list' || c[1] === 'create'), 'never edits or deletes');
  assert.ok(calls.every(c => c.includes('-R') && c.includes('o/r')));
});

test('labels is idempotent', () => {
  const { gh, calls } = fakeGh({ labels: LABELS.map(l => l[0]) });
  assert.deepEqual(ensureLabels(gh).created, []);
  assert.equal(calls.length, 1);
});

test('next under a parent keeps sub-issue order and skips closed, claimed and blocked tickets', () => {
  const issues = {
    11: issue(11, { assignees: ['me'] }),
    12: issue(12, { blockedBy: [[11, 'OPEN']] }),
    13: issue(13, { blockedBy: [[10, 'CLOSED']], labels: ['plan:grill'] }),
    14: issue(14),
  };
  const parent = {
    number: 9, title: 'map', url: 'u', labels: [{ name: 'plan:map' }], subIssuesSummary: { total: 5, completed: 1 },
    subIssues: { nodes: [{ number: 10, state: 'CLOSED' }, { number: 11, state: 'OPEN' }, { number: 12, state: 'OPEN' }, { number: 13, state: 'OPEN' }, { number: 14, state: 'OPEN' }] },
  };
  const { gh, calls } = fakeGh({ issues, parent });
  const out = frontier(gh, { parent: '9' });
  assert.equal(out.next.number, 13);
  assert.deepEqual(out.next.labels, ['plan:grill']);
  assert.deepEqual(out.ready.map(i => i.number), [13, 14]);
  assert.deepEqual(out.blocked.map(i => i.number), [12]);
  assert.deepEqual(out.claimed.map(i => i.number), [11]);
  assert.deepEqual(out.progress, { total: 5, completed: 1 });
  assert.ok(!calls.some(c => c[2] === '10'), 'closed children are not fetched');
});

test('next without a parent takes the oldest unblocked ready-for-agent issue', () => {
  const issues = {
    20: issue(20, { labels: ['ready-for-agent'], createdAt: '2026-11-03T00:00:00Z' }),
    21: issue(21, { labels: ['ready-for-agent'], createdAt: '2026-11-01T00:00:00Z', blockedBy: [[5, 'OPEN']] }),
    22: issue(22, { labels: ['ready-for-agent'], createdAt: '2026-11-02T00:00:00Z' }),
    23: issue(23, { labels: ['needs-triage'], createdAt: '2026-10-01T00:00:00Z' }),
  };
  const { gh } = fakeGh({ issues });
  const out = frontier(gh, {});
  assert.equal(out.next.number, 22);
  assert.deepEqual(out.ready.map(i => i.number), [22, 20]);
  assert.deepEqual(out.blocked.map(i => i.number), [21]);
});

test('an empty frontier says so instead of guessing', () => {
  const { gh } = fakeGh({ issues: {} });
  assert.equal(frontier(gh, {}).next, null);
});

test('arguments accept #n, a repo flag in either form', () => {
  assert.deepEqual(parseArgs(['next', '#12', '-R', 'o/r']), { cmd: 'next', repo: 'o/r', parent: '12' });
  assert.deepEqual(parseArgs(['labels', '--repo=o/r']), { cmd: 'labels', repo: 'o/r', parent: null });
});
