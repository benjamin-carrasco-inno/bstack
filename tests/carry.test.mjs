import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../plugins/bstack/scripts/guard.mjs';
import { deliver, handle } from '../plugins/bstack/scripts/verdict.mjs';
import { mergeInChain, sameChange } from '../plugins/bstack/scripts/lib/carry.mjs';
import { commentBody } from '../plugins/bstack/scripts/lib/verdicts.mjs';
import { tierZeroDocs } from '../plugins/bstack/scripts/risk-tier.mjs';

const sha = c => c.repeat(40);
const [BASE_OLD, PR_COMMIT, JUDGED, EXTRA, MAIN_TIP, MERGE, MERGE2, MAIN_TIP2] = ['0', '1', '2', '3', '4', '5', '6', '7'].map(sha);
const GREEN = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const RED = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }];

const codeFile = (file, { pre = '1111111', post = '2222222', at = 10, context = ['a', 'b'], added = 'x = 1', enclosing = 'def run():' } = {}) => [
  `diff --git a/${file} b/${file}`, `index ${pre}..${post} 100644`, `--- a/${file}`, `+++ b/${file}`,
  `@@ -${at},3 +${at},4 @@ ${enclosing}`, ...context.map(l => ` ${l}`), `+${added}`, ' c',
].join('\n');
const changelog = (neighbour, { pre = '3333333' } = {}) => [
  'diff --git a/CHANGELOG.md b/CHANGELOG.md', `index ${pre}..4444444 100644`, '--- a/CHANGELOG.md', '+++ b/CHANGELOG.md',
  '@@ -1,3 +1,4 @@', ' ## Unreleased', '+- feat: carry verdicts', ` ${neighbour}`,
].join('\n');
const diffOf = (...files) => `${files.join('\n')}\n`;

const CODE = 'app/main.py';
const DATA = 'app/db.py';
const DELETE = 'conn.execute("DELETE FROM orders")';
const JUDGED_CODE = diffOf(codeFile(CODE), changelog('- fix: older'));
const MERGED_CODE = diffOf(codeFile(CODE, { pre: '5555555', post: '6666666', at: 40 }), changelog('- feat: from main', { pre: '7777777' }));
const JUDGED_DATA = diffOf(codeFile(DATA, { added: DELETE }), changelog('- fix: older'));
const MERGED_DATA = diffOf(codeFile(DATA, { added: DELETE }), changelog('- feat: from main', { pre: '7777777' }));

const commit = (s, ...parents) => ({ sha: s, parents });
const MERGED_ONCE = [commit(PR_COMMIT, BASE_OLD), commit(JUDGED, PR_COMMIT), commit(MERGE, JUDGED, MAIN_TIP)];

const verdict = (result, at = JUDGED) => ({ body: commentBody('verdict', result, at, 'report'), createdAt: '2026-11-25T10:00:00Z' });
const interrogate = (blocking, at = JUDGED) => ({ body: commentBody('interrogate', { confirmed: blocking, blocking }, at, 'report'), createdAt: '2026-11-25T11:00:00Z' });
const POLICY_READ = '/contents/.github/risk-paths.txt?ref=';
const notFound = endpoint => { throw new Error(`HTTP 404: ${endpoint}`); };
const carryApiCall = c => c.startsWith('api') && !c.includes(POLICY_READ);

function fakeGitHub({ head = MERGE, commits = MERGED_ONCE, diffs, comments, checks = GREEN, files = {}, basePolicy, failApi = false, postFails = false, base = 'main' }) {
  const posted = [];
  const calls = [];
  const deps = {
    git: () => { throw new Error('no git'); },
    pending: { list: () => [], remove: () => {} },
    readFile: () => null,
    insideBstackSource: () => false,
    postComment: (_cwd, url, body) => { if (postFails) throw new Error('HTTP 502'); posted.push({ url, body }); },
    gh: (_cwd, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'view') return JSON.stringify({ number: 5, url: 'https://github.com/o/r/pull/5', headRefOid: head, baseRefName: base, state: 'OPEN', statusCheckRollup: checks, comments });
      if (args[1] === 'diff') return diffs[head];
      if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
      const endpoint = args.find(a => a.startsWith('repos/'));
      if (endpoint.includes(POLICY_READ)) return basePolicy ?? notFound(endpoint);
      if (failApi) throw new Error('HTTP 504: gateway timeout');
      if (/\/pulls\/5\/commits/.test(endpoint)) return commits.map(c => [c.sha, ...c.parents].join(' ')).join('\n');
      const compared = /\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(endpoint);
      if (compared) return diffs[compared[1]];
      const file = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(endpoint);
      if (file && files[file[2]]?.[file[1]] !== undefined) return files[file[2]][file[1]];
      return notFound(endpoint);
    },
  };
  return { deps, posted, calls };
}

const merge = (github, cwd = '/repo') => decide({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash --delete-branch' }, cwd }, github.deps);
const docs = tierZeroDocs([]);

test('a tier 1 verdict carries across a merge of main that leaves the PR diff unchanged, and the guard posts why', () => {
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.equal(merge(github), null);
  assert.equal(github.posted.length, 1);
  const { body } = github.posted[0];
  assert.match(body, /^<!-- bstack-carried v1 -->/);
  assert.ok(body.includes(`- reviewer verdict PASS, judged on ${JUDGED}`), body);
  assert.ok(body.includes(`for head ${MERGE}`), body);
  assert.ok(body.includes(`a merge of main: ${MERGE.slice(0, 7)}.`), body);
  assert.match(body, /same on both heads: sha256:[0-9a-f]{64}/);
  assert.match(body, /Risk tier 1 on 2222222, 1 on 5555555\./);
  assert.match(body, /CI is green on 5555555\./);
});

test('the carried comment is posted once', () => {
  const first = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS+NOTES')] });
  assert.equal(merge(first), null);
  const again = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS+NOTES'), { body: first.posted[0].body, createdAt: '2026-11-25T12:00:00Z' }] });
  assert.equal(merge(again), null);
  assert.equal(again.posted.length, 0);
});

test('a verdict carries across several merges of main in a row', () => {
  const commits = [...MERGED_ONCE, commit(MERGE2, MERGE, MAIN_TIP2)];
  const github = fakeGitHub({ head: MERGE2, commits, diffs: { [JUDGED]: JUDGED_CODE, [MERGE2]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.equal(merge(github), null);
  assert.ok(github.posted[0].body.includes(`a merge of main: ${MERGE2.slice(0, 7)}, ${MERGE.slice(0, 7)}.`), github.posted[0].body);
});

test('a tier 2 verdict and interrogate result carry when main changed only docs the PR also changes', () => {
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_DATA, [MERGE]: MERGED_DATA }, comments: [verdict('PASS'), interrogate(0)] });
  assert.equal(merge(github), null);
  const { body } = github.posted[0];
  assert.ok(body.includes(`- interrogate result confirmed=0 blocking=0, judged on ${JUDGED}`), body);
  assert.match(body, /Risk tier 2 on 2222222, 2 on 5555555\./);
  assert.match(body, /main changed none of the files this PR changes, other than docs\./);
});

test('a non-merge commit after the judged head means a new verdict', () => {
  const commits = [commit(PR_COMMIT, BASE_OLD), commit(JUDGED, PR_COMMIT), commit(EXTRA, JUDGED), commit(MERGE, EXTRA, MAIN_TIP)];
  const github = fakeGitHub({ commits, diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /no reviewer verdict for head 5555555\. The verdict on 2222222 does not carry to 5555555: the commits after it are not only merges of main\./);
  assert.equal(github.posted.length, 0);
});

test('a merge of another PR branch is not a merge of main', () => {
  const commits = [commit(PR_COMMIT, BASE_OLD), commit(JUDGED, PR_COMMIT), commit(EXTRA, BASE_OLD), commit(MERGE, JUDGED, EXTRA)];
  const github = fakeGitHub({ commits, diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /not only merges of main/);
});

test('a changed PR diff means a new verdict', () => {
  const changed = diffOf(codeFile(CODE, { pre: '5555555', at: 40, added: 'x = 2' }), changelog('- feat: from main'));
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: changed }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /does not carry to 5555555: the PR diff changed in app\/main\.py\./);
});

test('a conflict resolved by hand that changes a code hunk means a new verdict', () => {
  const resolved = diffOf(codeFile(CODE, { pre: '5555555', at: 40, context: ['a', 'b from main'] }), changelog('- fix: older'));
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: resolved }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /the PR diff changed in app\/main\.py/);
});

test('a code file the merge added to the PR diff means a new verdict', () => {
  const evil = diffOf(codeFile(CODE), codeFile('app/extra.py'), changelog('- fix: older'));
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: evil }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /the PR diff changed in app\/extra\.py/);
});

test('a risk tier that rose means a new verdict', () => {
  const readme = ['diff --git a/README.md b/README.md', 'index 8888888..9999999 100644', '--- a/README.md', '+++ b/README.md', '@@ -1,2 +1,3 @@', ' # Run', '+npm test || true', ' end'].join('\n');
  const files = {
    [JUDGED]: { 'README.md': '# Run\nnpm test || true\nend\n' },
    [MERGE]: { 'README.md': '# Run\n```!\nnpm test || true\n```\nend\n' },
  };
  const github = fakeGitHub({ diffs: { [JUDGED]: diffOf(codeFile(CODE), readme), [MERGE]: diffOf(codeFile(CODE), readme) }, files, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /does not carry to 5555555: the risk tier rose from 1 to 2\./);
});

test('red CI blocks a merge that would otherwise carry', () => {
  const github = fakeGitHub({ checks: RED, diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /CI is not green on 5555555/);
  assert.equal(github.posted.length, 0);
});

test('at tier 2, main changing a code file the PR also changes means a new verdict and interrogate', () => {
  const overlapping = diffOf(codeFile(DATA, { pre: '5555555', at: 40, added: DELETE }), changelog('- fix: older'));
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_DATA, [MERGE]: overlapping }, comments: [verdict('PASS'), interrogate(0)] });
  assert.match(merge(github) ?? '', /does not carry to 5555555: main changed app\/db\.py, which this tier 2 PR also changes\./);
});

test('at tier 1, main changing the same code file outside the PR hunks still carries', () => {
  assert.equal(merge(fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] })), null);
});

test('a carried FAIL verdict or blocking interrogate result still blocks', () => {
  assert.match(merge(fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('FAIL')] })) ?? '', /latest verdict for 2222222 is FAIL/);
  const blocking = fakeGitHub({ diffs: { [JUDGED]: JUDGED_DATA, [MERGE]: MERGED_DATA }, comments: [verdict('PASS'), interrogate(1)] });
  assert.match(merge(blocking) ?? '', /Interrogate found 1 blocking finding\(s\) on 2222222/);
});

test('a verdict on the head itself wins, and only the carried interrogate result is posted', () => {
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_DATA, [MERGE]: MERGED_DATA }, comments: [verdict('PASS', MERGE), interrogate(0)] });
  assert.equal(merge(github), null);
  assert.doesNotMatch(github.posted[0].body, /reviewer verdict/);
  assert.match(github.posted[0].body, /interrogate result confirmed=0 blocking=0/);
});

test('a head with its own results reads no commits and posts nothing', () => {
  const github = fakeGitHub({ diffs: { [MERGE]: MERGED_DATA }, comments: [verdict('PASS', MERGE), interrogate(0, MERGE)] });
  assert.equal(merge(github), null);
  assert.equal(github.posted.length, 0);
  assert.ok(!github.calls.some(carryApiCall), github.calls.join('\n'));
});

test('what the carry check cannot read from GitHub keeps the gate closed', () => {
  assert.match(merge(fakeGitHub({ failApi: true, diffs: { [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] })) ?? '', /does not carry to 5555555: bstack could not check it \(HTTP 504/);
  const many = Array.from({ length: 250 }, (_, i) => commit(i.toString(16).padStart(40, 'f'), BASE_OLD));
  assert.match(merge(fakeGitHub({ commits: [...many, ...MERGED_ONCE], diffs: { [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] })) ?? '', /GitHub lists at most 250/);
  assert.match(merge(fakeGitHub({ postFails: true, diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] })) ?? '', /could not post why the result on 2222222 holds for 5555555 \(HTTP 502\)/);
});

test('a base branch name that cannot go into an API path as it is never carries', () => {
  const github = fakeGitHub({ base: 'main?x=1', diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /cannot go into a GitHub API path/);
  assert.ok(!github.calls.some(carryApiCall), github.calls.join('\n'));
});

test('binary files in the PR diff never carry', () => {
  const binary = diffOf('diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ', codeFile(CODE));
  const github = fakeGitHub({ diffs: { [JUDGED]: binary, [MERGE]: binary }, comments: [verdict('PASS')] });
  assert.match(merge(github) ?? '', /the PR diff has binary files \(logo\.png\)/);
});

test('mergeInChain follows only first parents of merges whose second parent is off the PR', () => {
  assert.deepEqual(mergeInChain(MERGED_ONCE, MERGE), [MERGE, JUDGED]);
  assert.deepEqual(mergeInChain([...MERGED_ONCE, commit(MERGE2, MERGE, MAIN_TIP2)], MERGE2), [MERGE2, MERGE, JUDGED]);
  assert.deepEqual(mergeInChain([commit(JUDGED, BASE_OLD), commit(MERGE, MAIN_TIP, JUDGED)], MERGE), [MERGE]);
  assert.deepEqual(mergeInChain([commit(JUDGED, BASE_OLD), commit(MERGE, JUDGED, MAIN_TIP, MAIN_TIP2)], MERGE), [MERGE]);
  assert.deepEqual(mergeInChain([commit(JUDGED, BASE_OLD)], JUDGED), [JUDGED]);
});

test('sameChange compares code strictly and docs by their changed lines', () => {
  const same = sameChange(JUDGED_CODE, MERGED_CODE, docs);
  assert.equal(same.same, true);
  assert.deepEqual(same.overlap, [CODE]);
  assert.equal(sameChange(JUDGED_CODE, JUDGED_CODE, docs).fingerprint, same.fingerprint);
  const reworded = diffOf(codeFile(CODE), changelog('- fix: older').replace('+- feat: carry verdicts', '+- feat: carry results'));
  assert.deepEqual(sameChange(JUDGED_CODE, reworded, docs).changed, ['CHANGELOG.md']);
  const whitespace = diffOf(codeFile(CODE, { added: '  x = 1' }), changelog('- fix: older'));
  assert.deepEqual(sameChange(JUDGED_CODE, whitespace, docs).changed, [CODE]);
  const dropped = diffOf(codeFile(CODE));
  assert.deepEqual(sameChange(JUDGED_CODE, dropped, docs).changed, ['CHANGELOG.md']);
  assert.equal(sameChange(JUDGED_CODE, '', docs).same, false);
});

test('sameChange ignores the enclosing function git names in a hunk header', () => {
  const moved = diffOf(codeFile(CODE, { pre: '5555555', at: 40, enclosing: 'def added_by_main():' }), changelog('- fix: older'));
  assert.equal(sameChange(JUDGED_CODE, moved, docs).same, true);
});

test('sameChange counts a line ending changed to CRLF as a change', () => {
  const crlf = diffOf(codeFile(CODE, { added: 'x = 1\r' }), changelog('- fix: older'));
  assert.deepEqual(sameChange(JUDGED_CODE, crlf, docs).changed, [CODE]);
});

test('a docs-named file listed in .github/risk-paths.txt compares strictly and counts as overlap at tier 2', () => {
  const allowlist = (pre, neighbour) => ['diff --git a/security/admin-allowlist.txt b/security/admin-allowlist.txt', `index ${pre}..4444444 100644`,
    '--- a/security/admin-allowlist.txt', '+++ b/security/admin-allowlist.txt', '@@ -1,1 +1,2 @@', '+alice@example.com', ` ${neighbour}`].join('\n');
  const judged = diffOf(codeFile(CODE), allowlist('3333333', 'deny-all'));
  const moved = diffOf(codeFile(CODE), allowlist('7777777', 'allow-all'));
  assert.deepEqual(sameChange(judged, moved, tierZeroDocs(['security/*.txt'])).changed, ['security/admin-allowlist.txt']);
  const sameLines = diffOf(codeFile(CODE), allowlist('7777777', 'deny-all'));
  const github = fakeGitHub({ diffs: { [JUDGED]: judged, [MERGE]: sameLines }, comments: [verdict('PASS'), interrogate(0)], basePolicy: 'security/*.txt\n' });
  assert.match(merge(github) ?? '', /does not carry to 5555555: main changed security\/admin-allowlist\.txt, which this tier 2 PR also changes\./);
});

const reviewedAt = (at = JUDGED) => ({ agent_type: 'bstack:reviewer', cwd: '/repo', last_assistant_message: `Works.\nbstack-verdict: PASS pr=5 sha=${at}` });

test('the verdict hook posts a report whose head moved only by a merge of main, on the judged SHA', () => {
  const out = handle(reviewedAt(), fakeGitHub({ diffs: {}, comments: [] }).deps.gh);
  assert.equal(out.block, undefined, out.block);
  assert.equal(out.post.sha, JUDGED);
  assert.match(out.post.body, new RegExp(`^bstack-verdict: PASS sha=${JUDGED}$`, 'm'));
  assert.ok(out.post.body.includes(`Judged on ${JUDGED}. The PR head has since moved to ${MERGE} by a merge-in of main.`), out.post.body);
  assert.match(out.post.body, /^Works\.$/m);
});

test('the verdict hook posts across two merges of main in a row', () => {
  const commits = [...MERGED_ONCE, commit(MERGE2, MERGE, MAIN_TIP2)];
  const out = handle(reviewedAt(), fakeGitHub({ head: MERGE2, commits, diffs: {}, comments: [] }).deps.gh);
  assert.ok(out.post?.body.includes(`Judged on ${JUDGED}. The PR head has since moved to ${MERGE2} by a merge-in of main.`), out.block);
});

test('the verdict hook refuses a report when a PR commit follows the judged SHA', () => {
  const afterNonMerge = [commit(PR_COMMIT, BASE_OLD), commit(JUDGED, PR_COMMIT), commit(EXTRA, JUDGED)];
  const afterPrMerge = [commit(PR_COMMIT, BASE_OLD), commit(JUDGED, PR_COMMIT), commit(EXTRA, BASE_OLD), commit(MERGE, JUDGED, EXTRA)];
  for (const [head, commits] of [[EXTRA, afterNonMerge], [MERGE, afterPrMerge]]) {
    const out = handle(reviewedAt(), fakeGitHub({ head, commits, diffs: {}, comments: [] }).deps.gh);
    assert.equal(out.post, undefined);
    assert.ok(out.block.startsWith(`PR 5 head is now ${head}, not ${JUDGED}. Check out the new head`), out.block);
  }
});

test('the verdict hook refuses a moved head whose commits it cannot read or GitHub cannot list in full', () => {
  const unreadable = handle(reviewedAt(), fakeGitHub({ failApi: true, diffs: {}, comments: [] }).deps.gh);
  assert.equal(unreadable.post, undefined);
  assert.match(unreadable.block, /head is now 5{40}, not 2{40}, and bstack could not read its commits \(HTTP 504: gateway timeout\)/);
  const many = Array.from({ length: 250 }, (_, i) => commit(i.toString(16).padStart(40, 'f'), BASE_OLD));
  const tooMany = handle(reviewedAt(), fakeGitHub({ commits: [...many, ...MERGED_ONCE], diffs: {}, comments: [] }).deps.gh);
  assert.equal(tooMany.post, undefined);
  assert.match(tooMany.block, /could not read its commits \(the PR has 253 commits, and GitHub lists at most 250\)/);
});

test('the guard carries a verdict the hook posted after a merge-in to the new head', () => {
  const out = handle(reviewedAt(), fakeGitHub({ diffs: {}, comments: [] }).deps.gh);
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [{ body: out.post.body, createdAt: '2026-11-25T10:00:00Z' }] });
  assert.equal(merge(github), null);
  assert.ok(github.posted[0].body.includes(`- reviewer verdict PASS, judged on ${JUDGED}`), github.posted[0].body);
});

test('a verdict saved during an outage after a merge-in is posted and carried at the next merge', () => {
  const saved = [];
  const github = fakeGitHub({ diffs: { [JUDGED]: JUDGED_CODE, [MERGE]: MERGED_CODE }, comments: [] });
  const out = deliver(reviewedAt(), { gh: github.deps.gh, read: () => [], save: e => saved.push(e), now: () => '2026-11-25T10:00:00Z' });
  assert.match(out.systemMessage, /saved locally/);
  const removed = [];
  github.deps.pending = { list: () => saved.map((entry, i) => ({ file: `f${i}`, entry })), remove: file => removed.push(file) };
  assert.equal(merge(github), null);
  assert.equal(github.posted[0].body, saved[0].body);
  assert.ok(github.posted[1].body.includes(`- reviewer verdict PASS, judged on ${JUDGED}`), github.posted[1]?.body);
  assert.deepEqual(removed, ['f0']);
});

test('a verdict saved after a merge-in is dropped once the head moves again', () => {
  const saved = [];
  const before = fakeGitHub({ diffs: {}, comments: [] });
  deliver(reviewedAt(), { gh: before.deps.gh, read: () => [], save: e => saved.push(e) });
  const github = fakeGitHub({ head: EXTRA, commits: [...MERGED_ONCE, commit(EXTRA, MERGE)], diffs: { [EXTRA]: MERGED_CODE }, comments: [] });
  github.deps.pending = { list: () => saved.map((entry, i) => ({ file: `f${i}`, entry })), remove: () => {} };
  assert.match(merge(github), /no reviewer verdict/);
  assert.equal(github.posted.length, 0);
});
