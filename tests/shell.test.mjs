import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, commandsIn, parseGit } from '../plugins/bstack/scripts/lib/shell.mjs';

test('segments split on operators outside quotes', () => {
  assert.deepEqual(splitSegments('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitSegments('echo "a; b" && c'), ['echo "a; b"', 'c']);
  assert.deepEqual(splitSegments('cmd 2>&1 | tee x'), ['cmd 2>&1', 'tee x']);
  assert.deepEqual(splitSegments('& git status'), ['git status']);
});

test('tokens drop quotes', () => {
  assert.deepEqual(tokenize(`git commit -m "fix: a b" -m 'c'`), ['git', 'commit', '-m', 'fix: a b', '-m', 'c']);
  assert.deepEqual(tokenize('a ""'), ['a', '']);
});

test('nested shells are unwrapped', () => {
  const cmds = commandsIn('pwsh -NoProfile -Command "git status; gh pr list"');
  assert.deepEqual(cmds.map(c => c.cmd), ['git', 'gh']);
});

test('git global options are skipped', () => {
  assert.deepEqual(parseGit(['-C', 'x', '-c', 'a=b', 'push', 'origin', 'main']), { dir: 'x', sub: 'push', rest: ['origin', 'main'] });
});
