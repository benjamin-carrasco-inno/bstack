import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, commandsIn, parseGit, redirectTargets, endsInRedirect, withoutHeredocBodies } from '../plugins/bstack/scripts/lib/shell.mjs';

test('segments split on operators outside quotes', () => {
  assert.deepEqual(splitSegments('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitSegments('echo "a; b" && c'), ['echo "a; b"', 'c']);
  assert.deepEqual(splitSegments('cmd 2>&1 | tee x'), ['cmd 2>&1', 'tee x']);
  assert.deepEqual(splitSegments('& git status'), ['git status']);
});

test('a | after > always splits, even when the > is escaped', () => {
  assert.deepEqual(splitSegments('echo x >| a.txt | tee b'), ['echo x >', 'a.txt', 'tee b']);
  assert.deepEqual(splitSegments('echo \\>|git push'), ['echo \\>', 'git push']);
  assert.deepEqual(redirectTargets('echo x >| a.txt'), ['a.txt']);
});

test('a dangling redirect is one whose > ends the segment unescaped', () => {
  assert.equal(endsInRedirect('echo x >'), true);
  assert.equal(endsInRedirect('echo x 2>'), true);
  assert.equal(endsInRedirect('echo x >>'), true);
  assert.equal(endsInRedirect('echo \\>'), false);
  assert.equal(endsInRedirect('echo `>', 'powershell'), false);
  assert.equal(endsInRedirect('echo ^>', 'cmd'), false);
  assert.equal(endsInRedirect('echo ^>'), true);
  assert.equal(endsInRedirect('echo ">"'), false);
  assert.equal(endsInRedirect('echo x > a.txt'), false);
  assert.equal(endsInRedirect('echo x 2>&'), false);
});

test('heredoc bodies are blanked, everything else is kept', () => {
  assert.equal(withoutHeredocBodies("cat <<'EOF' > a\nx => y\nEOF\nnode a"), "cat <<'EOF' > a\n\n\nnode a");
  assert.equal(withoutHeredocBodies('cat <<-E\n\ta > b\n\tE\necho'), 'cat <<-E\n\n\necho');
  assert.equal(withoutHeredocBodies('cat <<< "a > b"\necho x > y'), 'cat <<< "a > b"\necho x > y');
  assert.equal(withoutHeredocBodies('echo "<<EOF"\na > b'), 'echo "<<EOF"\na > b');
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
  assert.deepEqual(parseGit(['-C', 'x', '-c', 'a=b', 'push', 'origin', 'main']), { dir: 'x', gitDir: null, workTree: null, dirKnown: true, dirExpression: false, aliases: false, sub: 'push', rest: ['origin', 'main'] });
  assert.deepEqual(parseGit(['-C', 'x', '-C', '..', '-C', '/abs', '-C', 'y', '-c', 'alias.z=reset', 'z']), { dir: '/abs/y', gitDir: null, workTree: null, dirKnown: true, dirExpression: false, aliases: true, sub: 'z', rest: [] });
  assert.deepEqual(parseGit(['--git-dir=g', '--work-tree', 'w', 'commit']), { dir: null, gitDir: 'g', workTree: 'w', dirKnown: true, dirExpression: false, aliases: false, sub: 'commit', rest: [] });
  assert.equal(parseGit(['-C', '', '-C', 'sub', 'push']).dir, 'sub');
  assert.equal(parseGit(['-C', '$X', '-C', 'sub', 'push']).dirKnown, false);
  assert.equal(parseGit(['-C', '$X', '-C', '/abs', 'push']).dirKnown, true);
});

test('only an unquoted ( makes a -C path an expression', () => {
  const dirOf = line => { const [c] = commandsIn(line); return parseGit(c.args, c.expressions); };
  for (const line of ['git -C "C:/dev/repo (1)" push', "git -C 'C:/Program Files (x86)/r' push", 'git -C "/a (1)" -C sub push']) {
    assert.equal(dirOf(line).dirKnown, true, line);
  }
  for (const line of ['git -C @(Get-Location) push', 'git -C C:/x(1) push', 'git -C x(1) -C sub push', 'git -C "$(pwd)" push']) {
    assert.equal(dirOf(line).dirKnown, false, line);
  }
  assert.equal(dirOf('git -C x(1) -C /abs push').dirKnown, true);
});
