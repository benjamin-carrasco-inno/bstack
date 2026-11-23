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

const gitCalls = line => commandsIn(line).filter(c => c.cmd === 'git').map(c => c.args.join(' '));

test('commands inside PowerShell if, elseif and else blocks are reached', () => {
  assert.deepEqual(gitCalls('if ($?) { git push origin main }'), ['push origin main']);
  assert.deepEqual(gitCalls('git add -A; if ($?) { git commit -m "x" }'), ['add -A', 'commit -m x']);
  assert.deepEqual(gitCalls('if ($x) { git status } elseif ($y) { git fetch } else { git push origin main }'), ['status', 'fetch', 'push origin main']);
  assert.deepEqual(gitCalls('if (git push origin main) { echo ok }'), ['push origin main']);
  assert.deepEqual(gitCalls('Get-ChildItem | ForEach-Object { git -C $_ push origin main }'), ['-C $_ push origin main']);
});

test('a group glued to an operator is still a group', () => {
  assert.deepEqual(gitCalls('if (!(git push origin main)) { echo x }'), ['push origin main']);
  assert.deepEqual(gitCalls('if (-not (git push origin main)) { echo x }'), ['push origin main']);
  assert.deepEqual(gitCalls('if (-not(git push origin main)) { echo x }'), ['push origin main']);
  assert.deepEqual(gitCalls('$ok = (git push origin main)'), ['push origin main']);
  assert.deepEqual(gitCalls('$ok=(git push origin main)'), ['push origin main']);
  assert.deepEqual(gitCalls('! ( git push origin main )'), ['push origin main']);
});

test('a PowerShell backtick-escaped bracket neither opens nor closes a group', () => {
  assert.deepEqual(splitSegments('{ echo `{ } git push origin main }'), ['echo `{', 'git push origin main }']);
  assert.deepEqual(splitSegments('( echo `) ) ; git status'), ['echo `)', 'git status']);
});

test('a stray closer after an escaped brace stays text: PowerShell refuses to parse that line and runs none of it', () => {
  assert.deepEqual(splitSegments('echo `{ } git push origin main'), ['echo `{ } git push origin main']);
});

test('commands inside bash if, while, for, subshells and groups are reached', () => {
  assert.deepEqual(gitCalls('if true; then git commit --no-verify -m x; fi'), ['commit --no-verify -m x']);
  assert.deepEqual(gitCalls('if git diff --quiet; then echo same; elif true; then git push origin main; else git status; fi'), ['diff --quiet', 'push origin main', 'status']);
  assert.deepEqual(gitCalls('while true; do git push origin main; done'), ['push origin main']);
  assert.deepEqual(gitCalls('for b in a c; do git push origin "$b"; done'), ['push origin $b']);
  assert.deepEqual(gitCalls('( git push origin main )'), ['push origin main']);
  assert.deepEqual(gitCalls('(cd x && git push origin main)'), ['push origin main']);
  assert.deepEqual(gitCalls('{ git push origin main; }'), ['push origin main']);
});

test('quotes, substitutions and ref syntax keep their braces and parentheses', () => {
  assert.deepEqual(splitSegments('git commit -m "fix (scope) {x}"'), ['git commit -m "fix (scope) {x}"']);
  assert.deepEqual(gitCalls(`git commit -m 'feat(guard): {a} (b)'`), ['commit -m feat(guard): {a} (b)']);
  assert.deepEqual(gitCalls('git rev-parse @{u}'), ['rev-parse @{u}']);
  assert.deepEqual(gitCalls('git push origin HEAD@{0}:refs/heads/x'), ['push origin HEAD@{0}:refs/heads/x']);
  assert.deepEqual(gitCalls('git push origin $(git branch --show-current)'), ['push origin $(git branch --show-current)']);
  assert.deepEqual(gitCalls('( git log ${REF} $(date) )'), ['log ${REF} $(date)']);
  assert.deepEqual(gitCalls('git log ) }'), ['log ) }']);
});

test('git global options are skipped', () => {
  assert.deepEqual(parseGit(['-C', 'x', '-c', 'a=b', 'push', 'origin', 'main']), { dir: 'x', gitDir: null, workTree: null, sub: 'push', rest: ['origin', 'main'] });
  assert.deepEqual(parseGit(['--git-dir=g', '--work-tree', 'w', 'commit']), { dir: null, gitDir: 'g', workTree: 'w', sub: 'commit', rest: [] });
});
