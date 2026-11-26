import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentArgs, deliver, handle, kindOf, readSettled, retrying, transient } from '../plugins/bstack/scripts/verdict.mjs';
import { decide } from '../plugins/bstack/scripts/guard.mjs';
import { commentBody, parseReport, latestFor } from '../plugins/bstack/scripts/lib/verdicts.mjs';
import { pendingStore } from '../plugins/bstack/scripts/lib/pending.mjs';

const SHA = 'c'.repeat(40);

// An agent transcript as Claude Code writes it: one JSON entry per line.
function transcript(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-test-')), 'agent.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const prompt = text => ({ type: 'user', message: { role: 'user', content: text } });
const said = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const handback = message => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'SubagentHandback', input: { message } }] } });
const delivered = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"success":true}' }] }] } };

const gh = head => () => JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: head });

test('only bstack reviewer and adversary agents are handled', () => {
  assert.equal(kindOf('bstack:reviewer'), 'verdict');
  assert.equal(kindOf('bstack:adversary'), 'interrogate');
  assert.equal(kindOf('Explore'), null);
  assert.deepEqual(handle({ agent_type: 'Explore', last_assistant_message: 'x' }, gh(SHA)), {});
});

test('a report with a matching head is posted with the marker', () => {
  const out = handle({ agent_type: 'bstack:reviewer', last_assistant_message: `Works.\n\nbstack-verdict: PASS+NOTES pr=7 sha=${SHA}` }, gh(SHA));
  assert.equal(out.post.pr, 'https://github.com/o/r/pull/7');
  assert.ok(out.post.body.startsWith('<!-- bstack-verdict v1 -->'));
  assert.equal(latestFor('verdict', [{ body: out.post.body, createdAt: '2026-11-22T10:00:00Z' }], SHA).result, 'PASS+NOTES');
});

test('a report handed back through SubagentHandback is posted on the first stop', () => {
  // The run ends with the hand-back tool call, so Claude Code sends no last_assistant_message.
  const file = transcript([prompt('PR 7 in o/r.'), said('Checking the diff.'), handback(`Works.\n\nbstack-verdict: PASS+NOTES pr=7 sha=${SHA}`), delivered]);
  const out = handle({ agent_type: 'bstack:reviewer', stop_hook_active: false, agent_transcript_path: file }, gh(SHA));
  assert.equal(out.post?.pr, 'https://github.com/o/r/pull/7');
  assert.match(out.post.body, /^Works\.$/m);
  assert.equal(latestFor('verdict', [{ body: out.post.body, createdAt: '2026-11-22T10:00:00Z' }], SHA).result, 'PASS+NOTES');
});

test('the newest report in the transcript wins', () => {
  const file = transcript([
    prompt('PR 7 in o/r.'),
    handback(`bstack-interrogate: confirmed=2 blocking=2 pr=7 sha=${SHA}`),
    said(`Re-ran both.\nbstack-interrogate: confirmed=1 blocking=0 pr=7 sha=${SHA}`),
    handback(`Re-ran both.\nbstack-interrogate: confirmed=1 blocking=0 pr=7 sha=${SHA}`),
  ]);
  const out = handle({ agent_type: 'bstack:adversary', agent_transcript_path: file }, gh(SHA));
  assert.match(out.post.body, /^bstack-interrogate: confirmed=1 blocking=0 sha=/m);
  assert.deepEqual(latestFor('interrogate', [{ body: out.post.body }], SHA), { confirmed: 1, blocking: 0 });
});

test('a missing line or a moved head sends the agent back once, then warns the user', () => {
  assert.ok(handle({ agent_type: 'bstack:reviewer', last_assistant_message: 'looks fine' }, gh(SHA)).block);
  const file = transcript([prompt('PR 7 in o/r. Judge it.'), handback('looks fine')]);
  const gaveUp = handle({ agent_type: 'bstack:reviewer', last_assistant_message: 'looks fine', stop_hook_active: true, agent_transcript_path: file }, gh(SHA));
  assert.equal(gaveUp.block, undefined);
  assert.match(gaveUp.warn, /PR 7 in o\/r/);
  assert.match(gaveUp.warn, /nothing was posted/i);
  const moved = handle({ agent_type: 'bstack:reviewer', last_assistant_message: `bstack-verdict: PASS pr=7 sha=${SHA}` }, gh('d'.repeat(40)));
  assert.match(moved.block, /head is now/);
  const movedAgain = handle({ agent_type: 'bstack:reviewer', stop_hook_active: true, last_assistant_message: `bstack-verdict: PASS pr=7 sha=${SHA}` }, gh('d'.repeat(40)));
  assert.match(movedAgain.warn, /head is now/);
});

test('a run that ended with a hand-back is warned about at once, since a block no longer reaches the agent', () => {
  const file = transcript([prompt('PR 7 in o/r.'), handback('looks fine'), delivered]);
  const out = handle({ agent_type: 'bstack:reviewer', stop_hook_active: false, agent_transcript_path: file }, gh(SHA));
  assert.equal(out.block, undefined);
  assert.match(out.warn, /for PR 7 in o\/r\. The/);
});

test('a report already on the PR is not posted twice', () => {
  const file = transcript([prompt('PR 7 in o/r.'), said(`Works.\nbstack-verdict: PASS pr=7 sha=${SHA}`), handback(`Works.\nbstack-verdict: PASS pr=7 sha=${SHA}`)]);
  const input = { agent_type: 'bstack:reviewer', agent_transcript_path: file };
  const first = handle(input, gh(SHA));
  const withComment = () => JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: SHA, comments: [{ body: first.post.body }] });
  assert.deepEqual(handle(input, withComment), {});
});

function recording(head) {
  const calls = [];
  const gh = (cwd, args) => { calls.push({ cwd, args }); return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: head }); };
  return { gh, calls };
}

test('a PR in another repo is read and posted there, whatever the cwd', () => {
  const prompts = ['PR 7 in o/r. Judge it.', 'Review o/r#7.', 'Review https://github.com/o/r/pull/7 please.'];
  for (const text of prompts) {
    const { gh, calls } = recording(SHA);
    const file = transcript([prompt(text), handback(`Works.\nbstack-verdict: PASS pr=7 sha=${SHA}`), delivered]);
    const out = handle({ agent_type: 'bstack:reviewer', cwd: '/elsewhere/billedcrop', agent_transcript_path: file }, gh);
    assert.deepEqual(calls[0].args.slice(0, 5), ['pr', 'view', '7', '-R', 'o/r'], text);
    assert.deepEqual(commentArgs(out.post, 'body.md'), ['pr', 'comment', 'https://github.com/o/r/pull/7', '-R', 'o/r', '--body-file', 'body.md']);
  }
});

test('a repo named only in the report is used too', () => {
  const { gh, calls } = recording(SHA);
  handle({ agent_type: 'bstack:reviewer', last_assistant_message: `PR 7 in o/r works.\nbstack-verdict: PASS pr=7 sha=${SHA}` }, gh);
  assert.deepEqual(calls[0].args.slice(0, 5), ['pr', 'view', '7', '-R', 'o/r']);
});

test('a repo named for another PR number is not used, and no repo keeps the cwd', () => {
  for (const text of ['PR 7. It fixes a regression from o/x#3.', 'PR 7. Judge it.']) {
    const { gh, calls } = recording(SHA);
    const file = transcript([prompt(text), handback(`bstack-verdict: PASS pr=7 sha=${SHA}`), delivered]);
    const out = handle({ agent_type: 'bstack:reviewer', cwd: '/repo', agent_transcript_path: file }, gh);
    assert.ok(!calls[0].args.includes('-R'), text);
    assert.ok(!commentArgs(out.post, 'body.md').includes('-R'), text);
  }
});

test('interrogate reports carry the confirmed count', () => {
  const r = parseReport('interrogate', `Tried 5 attacks.\nbstack-interrogate: confirmed=2 blocking=1 pr=#7 sha=${SHA}`);
  assert.deepEqual(r.result, { confirmed: 2, blocking: 1 });
  assert.equal(r.pr, '7');
});

test('an interrogate report without a blocking count counts every confirmed finding as blocking', () => {
  const r = parseReport('interrogate', `bstack-interrogate: confirmed=2 pr=7 sha=${SHA}`);
  assert.deepEqual(r.result, { confirmed: 2, blocking: 2 });
});

test('the last verdict line wins and backticks are tolerated', () => {
  const r = parseReport('verdict', `bstack-verdict: FAIL pr=7 sha=${'e'.repeat(40)}\nre-checked\n\`bstack-verdict: PASS pr=7 sha=${SHA}\``);
  assert.equal(r.result, 'PASS');
  assert.equal(r.sha, SHA);
});

test('a hand-back written after the hook starts is still read and posted', () => {
  const file = transcript([prompt('PR 7 in o/r.'), said('Checking the diff.')]);
  let pauses = 0;
  const pause = () => {
    if (++pauses === 2) fs.appendFileSync(file, JSON.stringify(handback(`Works.\nbstack-verdict: PASS pr=7 sha=${SHA}`)) + '\n');
  };
  const input = { agent_type: 'bstack:reviewer', stop_hook_active: false, agent_transcript_path: file };
  const out = handle(input, gh(SHA), f => readSettled(f, { pause }));
  assert.equal(out.post?.pr, 'https://github.com/o/r/pull/7');
});

const timedOut = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });

function outage(ms) {
  const clock = { now: 0, calls: [] };
  clock.gh = (cwd, args) => {
    if (clock.now < ms) { clock.now += 25000; throw timedOut(); }
    clock.calls.push(args);
    return args[1] === 'view' ? JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: SHA, comments: [] }) : '';
  };
  clock.pause = wait => { clock.now += wait; };
  return clock;
}

const reviewed = () => ({
  agent_type: 'bstack:reviewer',
  cwd: '/repo',
  agent_transcript_path: transcript([prompt('PR 7 in o/r.'), handback(`Works.\nbstack-verdict: PASS pr=7 sha=${SHA}`), delivered]),
});

test('a verdict is posted after a 30 s gh outage, with no agent rerun', () => {
  const clock = outage(30000);
  const out = deliver(reviewed(), { gh: retrying(clock.gh, { pause: clock.pause }), save: () => assert.fail('nothing should be saved') });
  assert.match(out.systemMessage, /verdict posted/);
  assert.deepEqual(clock.calls.map(a => a[1]), ['view', 'comment']);
});

test('a refused connection is retried like a timeout', () => {
  let calls = 0;
  const refused = 'Command failed: gh pr view 7\nPost "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.\n';
  const gh = retrying(() => { if (++calls < 3) throw new Error(refused); return 'ok'; }, { pause: () => {} });
  assert.equal(gh('/repo', ['pr', 'view', '7']), 'ok');
  assert.equal(calls, 3);
});

test('retries stop at once on an error that is not transient', () => {
  let calls = 0;
  const gh = retrying(() => { calls++; throw new Error('GraphQL: Could not resolve to a PullRequest with the number of 70.'); }, { pause: () => {} });
  assert.throws(() => gh('/repo', ['pr', 'view', '70']));
  assert.equal(calls, 1);
});

test('a repo name in the failed command line does not make the error transient', () => {
  for (const repo of ['acme/network-tools', 'acme/timeout-service', 'acme/eof']) {
    const e = new Error(`Command failed: gh pr view 999999 -R ${repo} --json number\nGraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)\n`);
    assert.equal(transient(e), false, repo);
  }
  assert.equal(transient(new Error('Command failed: gh pr view 7 -R acme/eof\nerror connecting to api.github.com\n')), true);
});

test('a connection the remote end resets is transient on Windows and POSIX', () => {
  for (const reason of ['wsarecv: An existing connection was forcibly closed by the remote host.', 'write: broken pipe', 'read: connection reset by peer']) {
    assert.equal(transient(new Error(`Command failed: gh pr view 5 -R o/r\nPost "https://api.github.com/graphql": read tcp 127.0.0.1:63016->127.0.0.1:18082: ${reason}\n`)), true, reason);
  }
});

test('a verdict that cannot be posted is saved by repo, PR and SHA, and the guard posts it at the next merge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-pending-'));
  const store = pendingStore(dir);
  const clock = outage(Infinity);
  const out = deliver(reviewed(), { gh: retrying(clock.gh, { pause: clock.pause }), save: store.save });
  assert.match(out.systemMessage, /saved/);
  const [saved] = store.list('o/r', '7');
  assert.equal(saved.entry.sha, SHA);

  const posted = [];
  const deps = {
    gh: (_cwd, args) => {
      if (args[1] === 'view') return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: SHA, baseRefName: 'main', state: 'OPEN', statusCheckRollup: [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: [] });
      if (args.at(-1) === 'repos/o/r/contents/.github/risk-paths.txt?ref=main') throw new Error('gh: Not Found (HTTP 404)');
      if (args.at(-1) === 'repos/o/r') return 'o/r';
      if (args[1] === 'diff') return 'diff --git a/app/main.py b/app/main.py\n--- a/app/main.py\n+++ b/app/main.py\n+x = 1\n';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    postComment: (_cwd, url, body) => posted.push({ url, body }),
    pending: store,
    readFile: () => null,
    insideBstackSource: () => false,
  };
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 7 -R o/r --squash' }, cwd: '/repo' }, deps), null);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(store.list('o/r', '7'), []);
});

test('a PR the hook cannot read during an outage is saved under the repo the report names', () => {
  const saved = [];
  const clock = outage(Infinity);
  deliver(reviewed(), { gh: retrying(clock.gh, { pause: clock.pause }), save: e => saved.push(e) });
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].repo, saved[0].pr, saved[0].sha, saved[0].kind], ['o/r', '7', SHA, 'verdict']);
  assert.equal(latestFor('verdict', [{ body: saved[0].body }], SHA).result, 'PASS');
});

test('a saved verdict keeps the time it was judged, so posting it late does not make it newest', () => {
  const saved = [];
  const clock = outage(Infinity);
  deliver(reviewed(), { gh: retrying(clock.gh, { pause: clock.pause }), save: e => saved.push(e), now: () => '2026-11-22T09:00:00.000Z' });
  assert.equal(saved[0].at, '2026-11-22T09:00:00.000Z');
  const laterFail = { body: commentBody('verdict', 'FAIL', SHA, 'found a bug'), createdAt: '2026-11-22T10:00:00Z' };
  const latePosted = { body: saved[0].body, createdAt: '2026-11-22T12:00:00Z' };
  assert.equal(latestFor('verdict', [laterFail, latePosted], SHA).result, 'FAIL');
  const earlierFail = { body: commentBody('verdict', 'FAIL', SHA, 'found a bug'), createdAt: '2026-11-22T08:00:00Z' };
  assert.equal(latestFor('verdict', [earlierFail, latePosted], SHA).result, 'PASS');
});

const NO_DNS = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
const GRAPHQL_EOF = 'Post "https://api.github.com/graphql": EOF';

test('DNS and dropped-connection failures from gh are retried', () => {
  for (const message of [NO_DNS, GRAPHQL_EOF]) {
    let calls = 0;
    const gh = retrying(() => { if (++calls < 3) throw new Error(`Command failed: gh pr view 7\n${message}\n`); return 'ok'; }, { pause: () => {} });
    assert.equal(gh('/repo', ['pr', 'view', '7']), 'ok', message);
  }
});

test('a PR read that fails on DNS saves the verdict instead of asking the agent to check the PR number', () => {
  const saved = [];
  const out = deliver(reviewed(), { gh: () => { throw new Error(`Command failed: gh pr view 7\n${NO_DNS}\n`); }, save: e => saved.push(e) });
  assert.equal(saved.length, 1);
  assert.match(out.systemMessage, /saved/);
});

test('a comment post that fails in any way after the PR read saves the verdict', () => {
  for (const message of [NO_DNS, GRAPHQL_EOF, 'GraphQL: Something went wrong while executing your query.']) {
    const saved = [];
    const gh = (_cwd, args) => {
      if (args[1] === 'view') return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: SHA, comments: [] });
      throw new Error(`Command failed: gh pr comment\n${message}\n`);
    };
    const out = deliver(reviewed(), { gh, save: e => saved.push(e) });
    assert.equal(saved.length, 1, message);
    assert.deepEqual([saved[0].repo, saved[0].pr, saved[0].sha], ['o/r', '7', SHA]);
    assert.match(out.systemMessage, /saved/);
  }
});

test('a transcript that stops growing without a hand-back is read once it is quiet', () => {
  const file = transcript([prompt('PR 7 in o/r.'), said('Done.')]);
  let pauses = 0;
  const entries = readSettled(file, { pause: () => pauses++, step: 100, quiet: 500, limit: 5000 });
  assert.equal(entries.length, 2);
  assert.equal(pauses, 5);
});
