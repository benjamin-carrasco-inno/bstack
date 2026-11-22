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

test('a PowerShell here-string is one word and never splits', () => {
  const line = "git commit -m @'\nfix: don't break x; or y\n'@; git status";
  assert.deepEqual(splitSegments(line), ["git commit -m @'\nfix: don't break x; or y\n'@", 'git status']);
  assert.deepEqual(tokenize(splitSegments(line)[0]), ['git', 'commit', '-m', "fix: don't break x; or y"]);
  assert.deepEqual(tokenize('a @"\r\nsay "hi" @x\r\n  "@ still\r\n"@ b'), ['a', 'say "hi" @x\r\n  "@ still', 'b']);
  assert.deepEqual(tokenize("a @'\n'@"), ['a', '']);
  assert.deepEqual(commandsIn("git commit -m @'\nfix: x\n\nbody\n'@\ngit push").map(c => c.cmd), ['git', 'git']);
  assert.deepEqual(tokenize("a @'b'"), ['a', '@b']);
});

test('nested shells are unwrapped', () => {
  const cmds = commandsIn('pwsh -NoProfile -Command "git status; gh pr list"');
  assert.deepEqual(cmds.map(c => c.cmd), ['git', 'gh']);
});

test('git global options are skipped', () => {
  assert.deepEqual(parseGit(['-C', 'x', '-c', 'a=b', 'push', 'origin', 'main']), { dir: 'x', sub: 'push', rest: ['origin', 'main'] });
});
