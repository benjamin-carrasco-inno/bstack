import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, kindOf } from '../plugins/bstack/scripts/verdict.mjs';
import { parseReport, latestFor } from '../plugins/bstack/scripts/lib/verdicts.mjs';

const SHA = 'c'.repeat(40);
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

test('a missing line or a moved head sends the agent back once', () => {
  assert.ok(handle({ agent_type: 'bstack:reviewer', last_assistant_message: 'looks fine' }, gh(SHA)).block);
  assert.deepEqual(handle({ agent_type: 'bstack:reviewer', last_assistant_message: 'looks fine', stop_hook_active: true }, gh(SHA)), {});
  const moved = handle({ agent_type: 'bstack:reviewer', last_assistant_message: `bstack-verdict: PASS pr=7 sha=${SHA}` }, gh('d'.repeat(40)));
  assert.match(moved.block, /head is now/);
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
