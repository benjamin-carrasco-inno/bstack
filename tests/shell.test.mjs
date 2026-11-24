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
  assert.deepEqual(redirectTargets('echo x >| a.txt'), [{ text: 'a.txt', expression: false, expands: false }]);
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

test('a << in arithmetic, in a multi-line quote or without its terminator line opens no heredoc', () => {
  for (const line of [
    'echo $((1<<2))\nrm -rf x\n2',
    '(( x <<= 2 ))\nrm -rf x\n2',
    'echo "\n1 <<X\n"\necho pwned > a\nX',
    "echo '\n<<X\n'\necho pwned > a\nX",
    'cat <<NOPE\necho pwned > a',
    'cat <<A <<B\nx\nA\necho pwned > a',
  ]) {
    assert.equal(withoutHeredocBodies(line), line, line);
  }
  assert.equal(withoutHeredocBodies('echo $((1<<2)); cat <<E\na > b\nE\necho'), 'echo $((1<<2)); cat <<E\n\n\necho');
  assert.equal(withoutHeredocBodies('echo "\n" && cat <<E\na > b\nE\necho'), 'echo "\n" && cat <<E\n\n\necho');
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
  assert.deepEqual(gitCalls('git push origin $(git branch --show-current)'), ['branch --show-current', 'push origin $(git branch --show-current)']);
  assert.deepEqual(gitCalls('( git log ${REF} $(date) )'), ['log ${REF} $(date)']);
  assert.deepEqual(gitCalls('git log ) }'), ['log ) }']);
});

test('a $( ), backtick or argument ( ) substitution adds its commands and stays one word of the outer command', () => {
  assert.deepEqual(gitCalls('echo $(git push origin main)'), ['push origin main']);
  assert.deepEqual(gitCalls('echo `git push origin main`'), ['push origin main']);
  assert.deepEqual(gitCalls('echo $(cd x; git push origin $(git branch --show-current))'), ['branch --show-current', 'push origin $(git branch --show-current)']);
  assert.deepEqual(gitCalls('git -C (Get-Location) push origin main'), ['-C (Get-Location) push origin main']);
  assert.deepEqual(gitCalls('git push origin (git branch --show-current)'), ['branch --show-current', 'push origin (git branch --show-current)']);
  assert.deepEqual(commandsIn('git -C (Join-Path a b) push').find(c => c.cmd === 'git').args, ['-C', '(Join-Path a b)', 'push']);
  assert.deepEqual(commandsIn('echo `git push origin main`', 0, 'powershell').map(c => c.cmd), ['echo']);
  assert.deepEqual(gitCalls('f() { git push origin main; }'), ['push origin main']);
});

test('a $( ) or bash backtick substitution inside double quotes adds its commands, nested to any depth', () => {
  const psCalls = line => commandsIn(line, 0, 'powershell').filter(c => c.cmd === 'git').map(c => c.args.join(' '));
  assert.deepEqual(gitCalls('echo "$(git push origin main)"'), ['push origin main']);
  assert.deepEqual(gitCalls('echo "a `git push origin main` b"'), ['push origin main']);
  assert.deepEqual(gitCalls('git commit -m "$(git log -1)"'), ['log -1', 'commit -m $(git log -1)']);
  assert.deepEqual(gitCalls('echo "$(echo ")"; git push origin main)"'), ['push origin main']);
  assert.deepEqual(gitCalls('echo "$(echo "$(echo ")"; git push origin main)")"'), ['push origin main']);
  assert.deepEqual(gitCalls('echo "$(echo "`git push origin main`")"'), ['push origin main']);
  assert.deepEqual(psCalls('Write-Output "$(git push origin main)"'), ['push origin main']);
  assert.deepEqual(psCalls('Write-Output "$(Write-Output "$(git push origin main)")"'), ['push origin main']);
});

test('a backslash escapes nothing in a PowerShell double-quoted string, so a following $( ) is still run', () => {
  const psCalls = line => commandsIn(line, 0, 'powershell').filter(c => c.cmd === 'git').map(c => c.args.join(' '));
  assert.deepEqual(psCalls('Write-Output "C:\\$(git push origin main)"'), ['push origin main']);
  assert.deepEqual(psCalls('Write-Output "$env:TEMP\\$(git push origin main)"'), ['push origin main']);
  assert.deepEqual(psCalls('Write-Output "\\$(git push origin main)"'), ['push origin main']);
  assert.deepEqual(gitCalls('echo "\\$(git push origin main)"'), []);
});

test('a long run of unclosed quoted $( parses in linear time', () => {
  const line = 'echo ' + '"$('.repeat(40) + 'x';
  const started = performance.now();
  splitSegments(line);
  splitSegments(line, 'powershell');
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
});

test('single quotes, an escaped $( and a PowerShell backtick keep a quoted substitution literal', () => {
  const psCalls = line => commandsIn(line, 0, 'powershell').filter(c => c.cmd === 'git');
  assert.deepEqual(gitCalls("echo '$(git push origin main)'"), []);
  assert.deepEqual(gitCalls("echo '`git push origin main`'"), []);
  assert.deepEqual(gitCalls('echo "\\$(git push origin main)"'), []);
  assert.deepEqual(gitCalls('echo "\\`git push origin main\\`"'), []);
  assert.deepEqual(psCalls("Write-Output '$(git push origin main)'"), []);
  assert.deepEqual(psCalls('Write-Output "`git push origin main`"'), []);
  assert.deepEqual(psCalls('Write-Output "`$(git push origin main)"'), []);
});

test('git global options are skipped', () => {
  assert.deepEqual(parseGit(['-C', 'x', '-c', 'a=b', 'push', 'origin', 'main']), { dir: 'x', gitDir: null, workTree: null, dirKnown: true, dirExpression: false, aliases: false, config: ['a'], sub: 'push', rest: ['origin', 'main'] });
  assert.deepEqual(parseGit(['-C', 'x', '-C', '..', '-C', '/abs', '-C', 'y', '-c', 'alias.z=reset', 'z']), { dir: '/abs/y', gitDir: null, workTree: null, dirKnown: true, dirExpression: false, aliases: true, config: ['alias.z'], sub: 'z', rest: [] });
  assert.deepEqual(parseGit(['--git-dir=g', '--work-tree', 'w', 'commit']), { dir: null, gitDir: 'g', workTree: 'w', dirKnown: true, dirExpression: false, aliases: false, config: [], sub: 'commit', rest: [] });
  assert.equal(parseGit(['-C', '', '-C', 'sub', 'push']).dir, 'sub');
  assert.equal(parseGit(['-C', '$X', '-C', 'sub', 'push']).dirKnown, false);
  assert.equal(parseGit(['-C', '$X', '-C', '/abs', 'push']).dirKnown, true);
});

test('only an unquoted ( makes a -C path an expression', () => {
  const dirOf = line => { const c = commandsIn(line).find(cmd => cmd.cmd === 'git'); return parseGit(c.args, c.expressions); };
  for (const line of ['git -C "C:/dev/repo (1)" push', "git -C 'C:/Program Files (x86)/r' push", 'git -C "/a (1)" -C sub push']) {
    assert.equal(dirOf(line).dirKnown, true, line);
  }
  for (const line of ['git -C @(Get-Location) push', 'git -C C:/x(1) push', 'git -C x(1) -C sub push', 'git -C "$(pwd)" push']) {
    assert.equal(dirOf(line).dirKnown, false, line);
  }
  assert.equal(dirOf('git -C x(1) -C /abs push').dirKnown, true);
});
