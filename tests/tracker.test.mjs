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
    if (group === 'issue' && action === 'view') return JSON.stringify(issues[String(ref).split('/').pop()]);
    if (group === 'issue' && action === 'list') {
      return JSON.stringify(Object.values(issues).filter(i => i.state === 'OPEN' && i.labels.some(l => l.name === 'ready-for-agent')).reverse());
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

const issue = (number, { state = 'OPEN', labels = [], assignees = [], blockedBy = [], subIssues = 0, createdAt = '2026-11-01T00:00:00Z' } = {}) => ({
  number, title: `ticket ${number}`, url: `https://github.com/o/r/issues/${number}`, state, createdAt,
  labels: labels.map(name => ({ name })), assignees: assignees.map(login => ({ login })),
  blockedBy: { nodes: blockedBy.map(([n, s]) => ({ number: n, state: s })), totalCount: blockedBy.length },
  subIssuesSummary: { total: subIssues, completed: 0 },
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
    subIssues: { nodes: [10, 11, 12, 13, 14].map(n => ({ number: n, state: n === 10 ? 'CLOSED' : 'OPEN', url: `https://github.com/o/r/issues/${n}` })) },
  };
  const { gh, calls } = fakeGh({ issues, parent });
  const out = frontier(gh, { parent: '9' });
  assert.equal(out.next.number, 13);
  assert.deepEqual(out.next.labels, ['plan:grill']);
  assert.deepEqual(out.ready.map(i => i.number), [13, 14]);
  assert.deepEqual(out.blocked.map(i => i.number), [12]);
  assert.deepEqual(out.claimed, [{ number: 11, title: 'ticket 11', url: 'https://github.com/o/r/issues/11', labels: [], assignees: ['me'] }]);
  assert.deepEqual(out.progress, { total: 5, completed: 1 });
  assert.ok(!calls.some(c => String(c[2]).endsWith('/10')), 'closed children are not fetched');
  assert.ok(calls.filter(c => c[1] === 'view' && c[2] !== '9').every(c => c[2].startsWith('https://') && !c.includes('-R')), 'children are read by URL, so another repo works');
});

test('next without a parent takes the oldest unblocked ready-for-agent issue', () => {
  const issues = {
    20: issue(20, { labels: ['ready-for-agent'], createdAt: '2026-11-03T00:00:00Z' }),
    21: issue(21, { labels: ['ready-for-agent'], createdAt: '2026-11-01T00:00:00Z', blockedBy: [[5, 'OPEN']] }),
    22: issue(22, { labels: ['ready-for-agent'], createdAt: '2026-11-02T00:00:00Z' }),
    23: issue(23, { labels: ['needs-triage'], createdAt: '2026-10-01T00:00:00Z' }),
    24: issue(24, { labels: ['ready-for-agent'], createdAt: '2026-10-02T00:00:00Z', subIssues: 3 }),
    25: issue(25, { labels: ['ready-for-agent', 'plan:spec'], createdAt: '2026-10-03T00:00:00Z' }),
    26: issue(26, { labels: ['ready-for-agent'], createdAt: '2026-10-04T00:00:00Z', assignees: ['me'] }),
  };
  const { gh, calls } = fakeGh({ issues });
  const out = frontier(gh, {});
  assert.equal(out.next.number, 22);
  assert.deepEqual(out.claimed.map(i => i.number), [26]);
  assert.ok(![...out.ready, ...out.blocked, ...out.claimed].some(i => i.number === 24 || i.number === 25), 'specs and maps are parents, not work');
  assert.deepEqual(out.skipped.map(i => i.number).sort(), [24, 25], 'and they are reported, not dropped silently');
  assert.equal(calls.length, 1, 'one list call, no call per issue');
  assert.ok(calls[0].includes('sort:created-asc'), 'the limit cuts the newest, not the oldest');
  assert.deepEqual(out.ready.map(i => i.number), [22, 20]);
  assert.deepEqual(out.blocked.map(i => i.number), [21]);
});

test('an empty frontier says so instead of guessing', () => {
  const { gh } = fakeGh({ issues: {} });
  assert.equal(frontier(gh, {}).next, null);
});

test('arguments accept #n and a repo flag in either form, and refuse what they do not understand', () => {
  assert.deepEqual(parseArgs(['next', '#12', '-R', 'o/r']), { cmd: 'next', repo: 'o/r', parent: '12' });
  assert.deepEqual(parseArgs(['labels', '--repo=o/r']), { cmd: 'labels', repo: 'o/r', parent: null });
  assert.throws(() => parseArgs(['next', '-R']), /needs owner\/repo/);
  assert.throws(() => parseArgs(['next', '-R', '--json']), /needs owner\/repo/);
  assert.throws(() => parseArgs(['next', '--all']), /unknown flag/);
  assert.throws(() => parseArgs(['next', '1', '2']), /one parent/);
  assert.throws(() => parseArgs(['labels', '12']), /takes no issue/);
});
