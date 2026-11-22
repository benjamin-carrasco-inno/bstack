import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, kindOf } from '../plugins/bstack/scripts/verdict.mjs';
import { parseReport, latestFor } from '../plugins/bstack/scripts/lib/verdicts.mjs';

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
    handback(`bstack-interrogate: confirmed=2 pr=7 sha=${SHA}`),
    said(`Re-ran both.\nbstack-interrogate: confirmed=0 pr=7 sha=${SHA}`),
    handback(`Re-ran both.\nbstack-interrogate: confirmed=0 pr=7 sha=${SHA}`),
  ]);
  const out = handle({ agent_type: 'bstack:adversary', agent_transcript_path: file }, gh(SHA));
  assert.match(out.post.body, /^bstack-interrogate: confirmed=0 sha=/m);
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

test('interrogate reports carry the confirmed count', () => {
  const r = parseReport('interrogate', `Tried 5 attacks.\nbstack-interrogate: confirmed=0 pr=#7 sha=${SHA}`);
  assert.equal(r.result, 0);
  assert.equal(r.pr, '7');
});

test('the last verdict line wins and backticks are tolerated', () => {
  const r = parseReport('verdict', `bstack-verdict: FAIL pr=7 sha=${'e'.repeat(40)}\nre-checked\n\`bstack-verdict: PASS pr=7 sha=${SHA}\``);
  assert.equal(r.result, 'PASS');
  assert.equal(r.sha, SHA);
});
