import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, ciState, realDeps, retryOnTimeout } from '../plugins/bstack/scripts/guard.mjs';
import { commentBody } from '../plugins/bstack/scripts/lib/verdicts.mjs';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const GREEN = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const CODE_DIFF = 'diff --git a/app/main.py b/app/main.py\n--- a/app/main.py\n+++ b/app/main.py\n+x = 1\n';
const DOCS_DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+more words\n';
const DATA_DIFF = 'diff --git a/app/db.py b/app/db.py\n--- a/app/db.py\n+++ b/app/db.py\n+conn.execute("DELETE FROM orders")\n';

const verdict = (result, sha = SHA, at = '2026-11-22T10:00:00Z') => ({ body: commentBody('verdict', result, sha, 'report'), createdAt: at });
const interrogate = (n, sha = SHA) => ({ body: commentBody('interrogate', n, sha, 'report'), createdAt: '2026-11-22T11:00:00Z' });

function deps({ branch = 'feat/x', upstream = '', pr = {}, diff = CODE_DIFF, files = {} } = {}) {
  return {
    git: (_cwd, args) => {
      if (args.includes('@{u}')) { if (!upstream) throw new Error('no upstream'); return upstream; }
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return branch;
      throw new Error(`not a git repository: git ${args.join(' ')}`);
    },
    gh: (_cwd, args) => {
      if (args[1] === 'view') return JSON.stringify({ number: 5, url: 'https://github.com/o/r/pull/5', headRefOid: SHA, state: 'OPEN', statusCheckRollup: GREEN, comments: [], ...pr });
      if (args[1] === 'diff') return diff;
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    readFile: f => files[f.replace(/\\/g, '/').split('/').pop()] ?? null,
    insideBstackSource: f => f.includes('bstack-src'),
    pending: { list: () => [], remove: () => {} },
    postComment: () => { throw new Error('unexpected comment'); },
  };
}

const shell = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', ...extra });
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: 'C:/repo' });
const blocked = (input, d = deps()) => assert.ok(decide(input, d), `expected block: ${JSON.stringify(input.tool_input)}`);
const allowed = (input, d = deps()) => assert.equal(decide(input, d), null);

test('ordinary commands pass', () => {
  allowed(shell('git status && npm test'));
  allowed(shell('ls -la | grep main'));
  allowed(ps('Get-ChildItem; git log --oneline -5'));
  allowed({ tool_name: 'Read', tool_input: { file_path: 'x' } });
});

test('push to the default branch is blocked, branches pass', () => {
  blocked(shell('git push origin main'));
  blocked(shell('git push origin HEAD:main'));
  blocked(shell('git push origin feat/x:refs/heads/master'));
  blocked(shell('git push'), deps({ branch: 'main' }));
  blocked(shell('git push -u origin HEAD'), deps({ branch: 'main' }));
  blocked(shell('git push --all origin'));
  allowed(shell('git push -u origin feat/x'));
  allowed(shell('git push'), deps({ branch: 'feat/x' }));
  allowed(shell('git push origin --delete feat/old'));
  blocked(shell('git push origin --delete main'));
});

test('push detection survives PowerShell and nesting', () => {
  blocked(ps('cd C:\\repo; & git push origin main 2>&1'));
  blocked(ps('pwsh -Command "git push origin main"'));
  blocked(shell('bash -c "git -C ../other push origin main"'));
  blocked(shell('cmd /c git push origin main'));
  blocked(shell('FOO=1 git push origin main'));
  blocked(ps('git.exe push origin main'));
});

test('git and gh inside blocks are checked', () => {
  blocked(ps('if ($?) { git push origin main }'));
  blocked(ps('if ($?) { git commit --no-verify -m x }'));
  blocked(ps('git status; if ($?) { gh pr merge 5 --squash --admin }'));
  blocked(ps('if ($x) { echo a } else { git push origin main }'));
  blocked(ps('if (git push origin main) { echo ok }'));
  blocked(ps('if (!(git push origin main)) { echo x }'));
  blocked(ps('if (-not(git push origin main)) { echo x }'));
  blocked(shell('! ( git push origin main )'));
  blocked(shell('if true; then git commit --no-verify -m x; fi'));
  blocked(shell('while true; do git push origin main; done'));
  blocked(shell('( git push origin main )'));
  blocked(shell('{ git push origin main; }'));
  allowed(ps('git add -A; if ($?) { git commit -m "fix (scope) {x}" }'));
  allowed(ps('if ($?) { git push -u origin feat/x }'));
  allowed(shell('if git diff --quiet; then echo same; else git status; fi'));
  allowed(shell('( cd sub && git log --oneline -5 )'));
  allowed(shell('git rev-parse @{u} && git log HEAD@{1}'));
});

test('force-push needs --force-with-lease', () => {
  blocked(shell('git push --force origin feat/x'));
  blocked(shell('git push -f origin feat/x'));
  blocked(shell('git push origin +feat/x'));
  allowed(shell('git push --force-with-lease origin feat/x'));
  blocked(shell('git push --force-with-lease origin main'));
});

test('hooks cannot be skipped', () => {
  blocked(shell('git commit -m "fix: x" --no-verify'));
  blocked(shell('git commit -nm "fix: x"'));
  blocked(shell('git push --no-verify origin feat/x'));
  allowed(shell('git commit -m "fix: handle -n flag"'));
  allowed(shell('git commit --amend --no-edit'));
});

test('rebase is blocked only on pushed branches', () => {
  blocked(shell('git rebase origin/main'), deps({ branch: 'feat/x', upstream: 'origin/feat/x' }));
  blocked(shell('git pull --rebase'), deps({ branch: 'feat/x', upstream: 'origin/feat/x' }));
  allowed(shell('git rebase origin/main'), deps({ branch: 'feat/x', upstream: 'origin/main' }));
  allowed(shell('git rebase origin/main'), deps({ branch: 'feat/x' }));
  allowed(shell('git rebase --abort'), deps({ branch: 'feat/x', upstream: 'origin/feat/x' }));
});

test('merge must be a plain squash merge', () => {
  blocked(shell('gh pr merge 5 --squash --auto'));
  blocked(shell('gh pr merge 5 --merge'));
  blocked(shell('gh pr merge 5 --squash --admin'));
});

test('merge needs green CI', () => {
  blocked(shell('gh pr merge 5 --squash'), deps({ diff: DOCS_DIFF, pr: { statusCheckRollup: [] } }));
  blocked(shell('gh pr merge 5 --squash'), deps({ diff: DOCS_DIFF, pr: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }] } }));
  blocked(shell('gh pr merge 5 --squash'), deps({ diff: DOCS_DIFF, pr: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] } }));
  allowed(shell('gh pr merge 5 --squash --delete-branch'), deps({ diff: DOCS_DIFF }));
});

test('tier 1 merge needs a verdict for the head SHA', () => {
  blocked(shell('gh pr merge 5 --squash'));
  blocked(shell('gh pr merge 5 --squash'), deps({ pr: { comments: [verdict('PASS', OLD)] } }));
  blocked(shell('gh pr merge 5 --squash'), deps({ pr: { comments: [verdict('PASS'), verdict('FAIL', SHA, '2026-11-22T12:00:00Z')] } }));
  blocked(shell('gh pr merge 5 --squash'), deps({ pr: { comments: [{ body: `bstack-verdict: PASS sha=${SHA}`, createdAt: '2026-11-22T10:00:00Z' }] } }));
  allowed(shell('gh pr merge 5 --squash --delete-branch'), deps({ pr: { comments: [verdict('PASS')] } }));
  allowed(shell('gh pr merge --squash'), deps({ pr: { comments: [verdict('PASS+NOTES')] } }));
});

test('a merge in another repo reads the PR, diff and verdict from that repo', () => {
  for (const command of ['gh pr merge 7 -R o/r --squash', 'gh pr merge 7 --repo=o/r --squash', 'gh pr merge https://github.com/o/r/pull/7 --squash']) {
    const calls = [];
    const base = deps({ pr: { number: 7, url: 'https://github.com/o/r/pull/7', comments: [verdict('PASS')] } });
    const d = { ...base, gh: (cwd, args) => { calls.push(args); return base.gh(cwd, args); } };
    allowed(shell(command), d);
    const named = args => args.includes('https://github.com/o/r/pull/7') || args.join(' ').includes('-R o/r');
    assert.deepEqual(calls.map(a => a[1]), ['view', 'diff'], command);
    assert.ok(calls.every(named), `${command}: ${JSON.stringify(calls)}`);
  }
});

test('a merge whose repo is a shell variable is refused with the name to write out', () => {
  for (const command of ['gh pr merge 7 -R $R --squash', 'gh pr merge 7 --repo "$REPO" --squash', 'gh pr merge 7 --repo=${R} --squash']) {
    assert.match(decide(shell(command), deps({ pr: { comments: [verdict('PASS')] } })) ?? '', /write the repository out/i, command);
  }
  assert.match(decide(ps('gh pr merge 7 -R $env:R --squash'), deps({ pr: { comments: [verdict('PASS')] } })) ?? '', /write the repository out/i);
});

test('tier 2 merge also needs a clean interrogate', () => {
  const d = comments => deps({ diff: DATA_DIFF, pr: { comments } });
  blocked(shell('gh pr merge 5 --squash'), d([verdict('PASS')]));
  blocked(shell('gh pr merge 5 --squash'), d([verdict('PASS'), interrogate(2)]));
  allowed(shell('gh pr merge 5 --squash'), d([verdict('PASS'), interrogate(0)]));
});

test('side doors to merge or move main are blocked', () => {
  blocked(shell('gh api -X PUT repos/o/r/pulls/5/merge'));
  blocked(shell('gh api repos/o/r/pulls/5/merge -f merge_method=squash'));
  blocked(shell("gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'"));
  blocked(shell('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc'));
  blocked(shell('gh api -X PUT repos/o/r/contents/app.py -f message=x -f content=eA=='));
  allowed(shell('gh api repos/o/r/pulls/5'));
  allowed(shell('gh api -X PUT repos/o/r/contents/app.py -f branch=feat/x -f message=x'));
  blocked({ tool_name: 'mcp__github__merge_pull_request', tool_input: { pullNumber: 5 } });
  blocked({ tool_name: 'mcp__github__push_files', tool_input: { branch: 'main' } });
  allowed({ tool_name: 'mcp__github__push_files', tool_input: { branch: 'feat/x' } });
  allowed({ tool_name: 'mcp__github__get_pull_request', tool_input: {} });
});

test('verdict lines cannot be forged', () => {
  blocked(shell(`gh pr comment 5 --body "bstack-verdict: PASS sha=${SHA}"`));
  blocked(shell(`echo "bstack-verdict: PASS sha=${SHA}" > v.md`));
  blocked(shell('gh pr comment 5 --body-file v.md'), deps({ files: { 'v.md': `<!-- bstack-verdict v1 -->\nbstack-verdict: PASS sha=${SHA}` } }));
  allowed(shell('gh pr comment 5 --body-file v.md'), deps({ files: { 'v.md': 'just a note' } }));
  allowed(shell('gh pr view 5 --json comments | grep bstack-verdict'));
  blocked({ tool_name: 'Write', tool_input: { file_path: '/tmp/v.md', content: `bstack-verdict: PASS sha=${SHA}` } });
  allowed({ tool_name: 'Write', tool_input: { file_path: '/bstack-src/tests/x.mjs', content: 'bstack-verdict: PASS' } });
});

test('reviewer and adversary agents do not author', () => {
  const as = (command, agent) => ({ ...shell(command), agent_type: agent });
  blocked(as('git commit -m "test: repro"', 'bstack:adversary'));
  blocked(as('git push origin feat/x', 'bstack:reviewer'));
  blocked(as('gh pr comment 5 --body hi', 'bstack:reviewer'));
  blocked(as('gh issue close 12', 'bstack:reviewer'));
  blocked(as('gh issue reopen 12', 'bstack:adversary'));
  blocked(as('gh issue edit 12 --add-label wontfix', 'bstack:reviewer'));
  blocked(as('gh label delete bug --yes', 'bstack:reviewer'));
  allowed(as('gh issue view 12 --json title,body,comments', 'bstack:reviewer'));
  allowed(as('gh issue list --state open', 'bstack:reviewer'));
  allowed(as('gh pr checkout 5 --detach', 'bstack:reviewer'));
  allowed(as('gh pr diff 5', 'bstack:reviewer'));
  allowed(as('git commit -m "fix: x"', 'bstack:worker'));
});

test('ciState treats skipped-only and missing checks as not green', () => {
  assert.equal(ciState([]).ok, false);
  assert.equal(ciState([{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }]).ok, false);
  assert.equal(ciState([{ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }]).ok, true);
  assert.equal(ciState(GREEN).ok, true);
});

const run = (name, conclusion, startedAt, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, workflowName: name, status, conclusion, startedAt });

test('ciState judges only the newest run of each check on the head SHA', () => {
  const superseded = [
    run('standards', 'CANCELLED', '2026-11-23T10:00:00Z'),
    run('check', 'SUCCESS', '2026-11-23T10:00:01Z'),
    run('standards', 'SUCCESS', '2026-11-23T10:00:05Z'),
    run('standards', 'SUCCESS', '2026-11-23T10:02:00Z'),
  ];
  assert.equal(ciState(superseded).ok, true);
  allowed(shell('gh pr merge 5 --squash'), deps({ pr: { statusCheckRollup: superseded, comments: [verdict('PASS')] } }));
  assert.match(ciState([run('standards', 'SUCCESS', '2026-11-23T10:00:00Z'), run('standards', 'FAILURE', '2026-11-23T10:01:00Z')]).detail, /failed: standards/);
  assert.match(ciState([run('standards', 'SUCCESS', '2026-11-23T10:00:00Z'), run('standards', 'CANCELLED', '2026-11-23T10:01:00Z')]).detail, /failed: standards/);
  assert.match(ciState([run('standards', 'CANCELLED', '2026-11-23T10:00:00Z'), run('standards', null, '2026-11-23T10:01:00Z', 'IN_PROGRESS')]).detail, /still running: standards/);
  assert.match(ciState([run('lint', 'SUCCESS', '2026-11-23T10:01:00Z'), run('standards', 'CANCELLED', '2026-11-23T10:00:00Z')]).detail, /failed: standards/);
});

function withPending(entries, { post = () => {}, pr = {} } = {}) {
  const removed = [];
  const posted = [];
  const d = deps({ pr });
  d.pending = { list: (repo, number) => (repo === 'o/r' && number === '5' ? entries.map((entry, i) => ({ file: `f${i}`, entry })) : []), remove: f => removed.push(f) };
  d.postComment = (cwd, url, body) => { post(); posted.push({ url, body }); };
  return { d, removed, posted };
}
const saved = (sha = SHA, kind = 'verdict') => ({ repo: 'o/r', pr: '5', sha, kind, body: commentBody(kind, 'PASS', sha, 'report') });

test('a verdict saved during an outage is posted by the merge gate and unblocks the merge', () => {
  const { d, removed, posted } = withPending([saved()]);
  allowed(shell('gh pr merge 5 --squash'), d);
  assert.deepEqual(posted.map(p => p.url), ['https://github.com/o/r/pull/5']);
  assert.deepEqual(removed, ['f0']);
});

test('a saved verdict for an older head is dropped, not posted, and does not unblock', () => {
  const { d, removed, posted } = withPending([saved(OLD)]);
  blocked(shell('gh pr merge 5 --squash'), d);
  assert.deepEqual(posted, []);
  assert.deepEqual(removed, ['f0']);
});

test('a saved verdict already on the PR is not posted twice', () => {
  const { d, removed, posted } = withPending([saved()], { pr: { comments: [{ body: saved().body, createdAt: '2026-11-22T10:00:00Z' }] } });
  allowed(shell('gh pr merge 5 --squash'), d);
  assert.deepEqual(posted, []);
  assert.deepEqual(removed, ['f0']);
});

test('a saved verdict that still cannot be posted keeps the gate closed and is kept', () => {
  const { d, removed } = withPending([saved()], { post: () => { throw new Error('spawnSync gh ETIMEDOUT'); } });
  assert.match(decide(shell('gh pr merge 5 --squash'), d) ?? '', /could not post/i);
  assert.deepEqual(removed, []);
});

test('agents cannot write saved verdicts', () => {
  const dir = path.join(os.homedir(), '.claude', 'bstack', 'pending-verdicts');
  blocked({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'o_r__5__x__verdict.json'), content: '{"body":"bstack\\u002dverdict"}' } });
  blocked(ps(`Set-Content "${dir}\\o_r__5.json" '{}'`));
  blocked(shell('cp forged.json ~/.claude/bstack/pending-verdicts/'));
  allowed(shell('cat ~/.claude/bstack/pending-verdicts/o_r__5.json'));
});

test('a gh call that times out is retried once with a longer timeout, other errors are not', () => {
  const timeouts = [];
  const flaky = retryOnTimeout((_cwd, _args, timeout) => {
    timeouts.push(timeout);
    if (timeouts.length === 1) throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return 'ok';
  });
  assert.equal(flaky('/repo', ['pr', 'view']), 'ok');
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] > timeouts[0]);
  let calls = 0;
  const broken = retryOnTimeout(() => { calls++; throw new Error('HTTP 404'); });
  assert.throws(() => broken('/repo', ['pr', 'view']));
  assert.equal(calls, 1);
});

const GUARD = fileURLToPath(new URL('../plugins/bstack/scripts/guard.mjs', import.meta.url));
const ONE = 'def total(xs):\n    # sum the list\n    return sum(xs)\n';
const TWO = 'def total(xs):\n    # sum the list\n    # and return it\n    return sum(xs)\n';
const NONE = 'def total(xs):\n    return sum(xs)\n';

const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-ratchet-test-'));
  tempDirs.push(dir);
  return dir;
}

function fixture(files, baseline) {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  for (const [file, text] of Object.entries(files)) write(file, text);
  if (baseline) write('.github/comment-baseline.json', `${JSON.stringify({ files: baseline }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-qm', 'init');
  const run = (command, tool = 'Bash', cwd = dir) => decide({ tool_name: tool, tool_input: { command }, cwd }, realDeps);
  return { dir, git, write, run, staged: () => git('diff', '--cached', '--name-only').trim() };
}

test('comment ratchet: a raised count is refused, naming the file, both counts and the fix', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  const reason = repo.run('git commit -m "feat: total"');
  assert.match(reason, /app\.py: baseline 1, this commit 2/);
  assert.match(reason, /rename or extract/);
  assert.match(reason, /test, type or runtime check/);
  assert.match(reason, /external: with proof/);
  assert.match(reason, /comments\.mjs" baseline/);
});

test('comment ratchet: a lowered or equal count is allowed', () => {
  const repo = fixture({ 'app.py': TWO, 'b.py': ONE }, { 'app.py': 2, 'b.py': 1 });
  repo.write('app.py', ONE);
  repo.write('b.py', `${ONE}x = 1\n`);
  repo.git('add', '-A');
  assert.equal(repo.run('git commit -m "refactor: fewer comments"'), null);
});

test('comment ratchet: a new file with comments and no baseline entry is refused', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('src/new.js', 'export const a = 1; // the answer\n');
  repo.git('add', '-A');
  assert.match(repo.run('git commit -m "feat: new"'), /src\/new\.js: baseline 0, this commit 1/);
  repo.write('src/new.js', 'export const a = 1;\n');
  repo.git('add', '-A');
  assert.equal(repo.run('git commit -m "feat: new"'), null);
});

test('comment ratchet: a repo without a baseline file is not affected', () => {
  const repo = fixture({ 'app.py': ONE });
  repo.write('app.py', TWO);
  repo.write('new.js', '// hello\n');
  repo.git('add', '-A');
  assert.equal(repo.run('git commit -am "feat: x"'), null);
});

test('comment ratchet: staged content counts, not the working tree', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', `${ONE}x = 1\n`);
  repo.git('add', 'app.py');
  repo.write('app.py', `${TWO}x = 1\n`);
  assert.equal(repo.run('git commit -m "feat: x"'), null);
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  repo.write('app.py', NONE);
  assert.match(repo.run('git commit -m "feat: x"'), /app\.py: baseline 1, this commit 2/);
});

test('comment ratchet: sees what git add, -a and pathspecs in the same call would commit', () => {
  const repo = fixture({ 'app.py': ONE, 'other.py': NONE }, { 'app.py': 1, 'other.py': 0 });
  repo.write('app.py', TWO);
  assert.match(repo.run('git add -A && git commit -m "feat: x"'), /app\.py/);
  assert.match(repo.run('git add app.py; git commit -m "feat: x"', 'PowerShell'), /app\.py/);
  assert.match(repo.run("git add -A; if ($?) { git commit -m 'x' }", 'PowerShell'), /app\.py/);
  assert.match(repo.run('git commit -am "feat: x"'), /app\.py/);
  assert.match(repo.run('git commit -m "feat: x" -- app.py'), /app\.py/);
  assert.match(repo.run('git commit -m "feat: x" app.py'), /app\.py/);
  assert.match(repo.run(`git -C "${repo.dir}" add -A && git -C "${repo.dir}" commit -m "feat: x"`, 'Bash', os.tmpdir()), /app\.py/);
  repo.write('other.py', `${NONE}y = 2\n`);
  assert.equal(repo.run('git commit -m "feat: y" other.py'), null);
  assert.equal(repo.run('git add other.py && git commit -m "feat: y"'), null);
  assert.equal(repo.run('git commit --dry-run -am "feat: x"'), null);
  assert.equal(repo.staged(), '', 'the guard must not touch the real index');
});

test('comment ratchet: shell redirections are neither pathspecs nor git add arguments', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  assert.match(repo.run('git add app.py 2>&1 && git commit -m "feat: x"') ?? '', /app\.py/);
  assert.match(repo.run('git add -A && git commit -m "feat: x" 2>&1') ?? '', /app\.py/);
  assert.match(repo.run('git commit -m ">x" app.py') ?? '', /app\.py/);
  repo.git('add', 'app.py');
  for (const command of ['git commit -m "feat: x" 2>&1', 'git commit -m "feat: x" 2>&1 | tail -3', "git commit -F - <<'EOF'\nfeat: x\n\nbody\nEOF", 'git commit -F - << EOF\nfeat: x\nEOF']) {
    assert.match(repo.run(command) ?? '', /app\.py/, command);
  }
  assert.match(repo.run('git commit -m "feat: x" 2>$null', 'PowerShell') ?? '', /app\.py/);
  assert.match(repo.run('git commit -m "feat: x" *>&1', 'PowerShell') ?? '', /app\.py/);

  const legit = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  legit.write('app.py', `${ONE}x = 1\n`);
  legit.git('add', 'app.py');
  for (const command of ['git commit -m "feat: x" > /dev/null', 'git commit -q -m "feat: x" >/dev/null 2>&1', 'git commit -m "feat: x" 2> err.txt', 'git commit -m "feat: x" &>log']) {
    assert.equal(legit.run(command), null, command);
  }
  assert.equal(legit.run('git commit -m "feat: x" > $null', 'PowerShell'), null);
});

test('comment ratchet: checks the repo that a cd earlier in the call moves to', () => {
  const repo = fixture({ 'app.py': ONE, 'src/b.py': NONE }, { 'app.py': 1, 'src/b.py': 0 });
  const elsewhere = tempDir();
  repo.write('app.py', TWO);
  assert.match(repo.run(`cd "${repo.dir}" && git add app.py && cd "${elsewhere}" && git -C "${repo.dir}" commit -m "feat: x"`, 'Bash', elsewhere) ?? '', /app\.py/);
  repo.git('add', 'app.py');
  assert.match(repo.run(`cd "${repo.dir}" && git commit -m "feat: x"`, 'Bash', elsewhere) ?? '', /app\.py/);
  assert.match(repo.run(`cd "${elsewhere}"; cd "${repo.dir}/src"; cd ..; git commit -m "feat: x"`, 'Bash', elsewhere) ?? '', /app\.py/);
  assert.match(repo.run(`Set-Location -Path "${repo.dir}"; git commit -m "feat: x"`, 'PowerShell', elsewhere) ?? '', /app\.py/);
  assert.match(repo.run(`sl "${repo.dir}"; git commit -m "feat: x"`, 'PowerShell', elsewhere) ?? '', /app\.py/);
  assert.match(repo.run(`pushd "${repo.dir}" && git commit -m "feat: x"`, 'Bash', elsewhere) ?? '', /app\.py/);
  assert.match(repo.run('cd "$OTHER" && cd - && git commit -m "feat: x"') ?? '', /app\.py/);

  const other = fixture({ 'z.py': 'x = 1\n' });
  other.write('z.py', 'x = 2\n');
  other.git('add', '-A');
  assert.equal(repo.run(`cd "${other.dir}" && git commit -m "chore: z"`), null);
});

test('comment ratchet: popd and cd - return to the directory they came from', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  const elsewhere = tempDir();
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  assert.match(repo.run(`pushd "${elsewhere}" && popd && git commit -m "feat: x"`) ?? '', /app\.py/);
  assert.match(repo.run(`cd "${elsewhere}"; cd -; git commit -m "feat: x"`) ?? '', /app\.py/);
  assert.match(repo.run(`Push-Location "${elsewhere}"; Pop-Location; git commit -m "feat: x"`, 'PowerShell') ?? '', /app\.py/);
  assert.match(repo.run(`pushd "${elsewhere}" && pushd "${repo.dir}" && popd && popd && git commit -m "feat: x"`) ?? '', /app\.py/);
});

test('push rules read the hook cwd, not a directory changed earlier in the line', () => {
  const onMain = fixture({ 'a.py': NONE });
  const onBranch = fixture({ 'b.py': NONE });
  onBranch.git('checkout', '-qb', 'feat/x');
  for (const line of [`pushd "${onBranch.dir}" && popd && git push`, `bash -c "cd '${onBranch.dir}' && git status"; git push`, `cd "${onBranch.dir}"; cd -; git push`, `cd "${onBranch.dir}" && git push`]) {
    assert.match(onMain.run(line) ?? '', /Direct push to main is blocked/, line);
  }
});

test('comment ratchet: unstaging earlier in the call is replayed on the temporary index only', () => {
  const repo = fixture({ 'app.py': ONE, 'b.py': NONE }, { 'app.py': 1, 'b.py': 0 });
  repo.write('app.py', TWO);
  repo.write('b.py', `${NONE}y = 2\n`);
  repo.git('add', '-A');
  const head = repo.git('rev-parse', 'HEAD');
  const unstaging = [
    ['git reset -q app.py && git commit -m "feat: b"', 'Bash'],
    ['git restore --staged app.py; git commit -m "feat: b"', 'PowerShell'],
    ['git restore -S app.py 2>&1 && git commit -m "feat: b"', 'Bash'],
    ['git reset -- app.py && git commit -m "feat: b"', 'Bash'],
    ['git reset HEAD app.py && git commit -m "feat: b"', 'Bash'],
    ['git reset -q HEAD -- app.py && git commit -m "feat: b"', 'Bash'],
    ['git reset && git add b.py && git commit -m "feat: b"', 'Bash'],
    ['git rm -q --cached app.py && git commit -m "feat: b"', 'Bash'],
  ];
  for (const [line, tool] of unstaging) assert.equal(repo.run(line, tool), null, line);
  for (const line of ['git reset --hard && git commit -m "feat: b"', 'git restore --staged --worktree app.py && git commit -m "feat: b"', 'git reset --soft HEAD && git commit -m "feat: b"']) {
    assert.match(repo.run(line) ?? '', /app\.py/, line);
  }
  assert.equal(repo.git('rev-parse', 'HEAD'), head);
  assert.equal(repo.staged(), 'app.py\nb.py', 'the guard must not touch the real index');
  assert.equal(fs.readFileSync(path.join(repo.dir, 'app.py'), 'utf8'), TWO, 'the guard must not touch the working tree');

  const fromBranch = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  fromBranch.git('checkout', '-qb', 'more');
  fromBranch.write('app.py', TWO);
  fromBranch.git('commit', '-qam', 'more comments');
  fromBranch.git('checkout', '-q', 'main');
  assert.match(fromBranch.run('git reset more -- app.py && git commit -m "feat: x"') ?? '', /app\.py: baseline 1, this commit 2/);
  assert.match(fromBranch.run('git reset -q more app.py && git commit -m "feat: x"') ?? '', /app\.py: baseline 1, this commit 2/);
  assert.equal(fromBranch.staged(), '');
});

test('comment ratchet: in Bash a glob in git add expands like bash, in PowerShell git reads it as a pathspec', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', `${ONE}x = 1\n`);
  repo.write('scratch/tmp.py', '# scratch note\n');
  repo.write('scratch/tmp.js', '// scratch note\n');
  repo.write('.hidden.py', '# hidden\n');
  for (const line of ['git add *.py && git commit -m "feat: x"', 'git add ?pp.py && git commit -m "feat: x"', 'git add [ab]pp.p[!a] && git commit -m "feat: x"']) {
    assert.equal(repo.run(line), null, line);
  }
  assert.match(repo.run('git add s*/*.py && git commit -m "feat: x"') ?? '', /scratch\/tmp\.py/);
  assert.match(repo.run('git add .h* && git commit -m "feat: x"') ?? '', /\.hidden\.py/);
  assert.match(repo.run('git add *.js && git commit -m "feat: x"') ?? '', /scratch\/tmp\.js/, 'an unmatched glob stays literal');
  assert.match(repo.run('git add *.py; git commit -m "feat: x"', 'PowerShell') ?? '', /scratch\/tmp\.py/);
});

test('comment ratchet: a PowerShell here-string message is one argument', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  assert.match(repo.run("git commit -m @'\nfix: don't break x\n'@", 'PowerShell') ?? '', /app\.py/);
  assert.match(repo.run('git commit -m @"\r\nfix: the "x" case\r\n"@', 'PowerShell') ?? '', /app\.py/);
});

test('comment ratchet: a rename keeps its count, and a baseline raised in the same commit is honoured', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.git('mv', 'app.py', 'lib.py');
  assert.equal(repo.run('git commit -m "refactor: rename"'), null);
  repo.write('lib.py', TWO);
  repo.write('.github/comment-baseline.json', `${JSON.stringify({ files: { 'lib.py': 2 } })}\n`);
  repo.git('add', '-A');
  assert.equal(repo.run('git commit -m "fix: note the library bug"'), null);
});

test('comment ratchet: a file already over its baseline may change but not grow', () => {
  const repo = fixture({ 'app.py': TWO }, { 'app.py': 1 });
  repo.write('app.py', `${TWO}x = 1\n`);
  repo.git('add', '-A');
  assert.equal(repo.run('git commit -m "fix: x"'), null);
  repo.write('app.py', `${TWO}# three\n`);
  repo.git('add', '-A');
  assert.match(repo.run('git commit -m "fix: x"'), /app\.py: baseline 1, this commit 3 \(2 before it\)/);
});

function conflicted(start) {
  const repo = fixture({ 'app.py': NONE, 'c.py': 'c = 0\n' }, { 'app.py': 0, 'c.py': 0 });
  repo.git('switch', '-qc', 'feat');
  repo.write('c.py', 'c = 2\n');
  repo.git('commit', '-qam', 'feat: c');
  repo.git('switch', '-q', 'main');
  repo.write('app.py', ONE);
  repo.write('c.py', 'c = 1\n');
  repo.git('commit', '-qam', 'human: comment app.py');
  const theirs = repo.git('rev-parse', 'HEAD').trim();
  repo.git('switch', '-q', 'feat');
  assert.throws(() => execFileSync('git', ['-C', repo.dir, ...start(theirs)], { stdio: 'ignore' }));
  repo.write('c.py', 'c = 3\n');
  return repo;
}

test('comment ratchet: concluding a merge or cherry-pick allows comments that came from the other side', () => {
  const merge = conflicted(() => ['merge', 'main']);
  assert.equal(merge.run('git add c.py && git commit --no-edit'), null);
  const pick = conflicted(theirs => ['cherry-pick', theirs]);
  assert.equal(pick.run('git add c.py && git commit --no-edit'), null);
});

test('comment ratchet: a comment the feature side adds while resolving a merge is still refused', () => {
  const merge = conflicted(() => ['merge', 'main']);
  merge.write('c.py', '# feature note\nc = 3\n');
  assert.match(merge.run('git add c.py && git commit --no-edit') ?? '', /c\.py: baseline 0, this commit 1/);
  merge.write('c.py', 'c = 3\n');
  merge.write('app.py', TWO);
  assert.match(merge.run('git add -A && git commit --no-edit') ?? '', /app\.py: baseline 0, this commit 2/);
});

test('comment ratchet: concluding a revert allows comments the reverted commit removed', () => {
  const repo = fixture({ 'app.py': ONE, 'c.py': 'c = 0\n' }, { 'app.py': 1, 'c.py': 0 });
  repo.write('app.py', NONE);
  repo.write('c.py', 'c = 1\n');
  repo.git('commit', '-qam', 'refactor: drop the comment');
  const cleanup = repo.git('rev-parse', 'HEAD').trim();
  repo.write('c.py', 'c = 2\n');
  repo.write('.github/comment-baseline.json', `${JSON.stringify({ files: { 'app.py': 0, 'c.py': 0 } })}\n`);
  repo.git('commit', '-qam', 'chore: lower the baseline');
  assert.throws(() => execFileSync('git', ['-C', repo.dir, 'revert', '--no-edit', cleanup], { stdio: 'ignore' }));
  repo.write('c.py', 'c = 2\n');
  assert.equal(repo.run('git add -A && git commit --no-edit'), null);
});

test('comment ratchet: --pathspec-from-file limits the commit like positional pathspecs', () => {
  const repo = fixture({ 'app.py': ONE, 'b.py': NONE }, { 'app.py': 1, 'b.py': 0 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  repo.write('b.py', `${NONE}y = 2\n`);
  repo.write('list.txt', 'b.py\n');
  assert.equal(repo.run('git commit -m x --pathspec-from-file=list.txt'), null);
  assert.equal(repo.run('git commit -m x --pathspec-from-file list.txt'), null);
  repo.git('reset', '-q');
  repo.write('list.txt', 'app.py\n');
  assert.match(repo.run('git commit -m x --pathspec-from-file=list.txt') ?? '', /app\.py: baseline 1, this commit 2/);
  repo.write('list.txt', 'b.py\0app.py\0');
  assert.match(repo.run('git commit -m x --pathspec-from-file list.txt --pathspec-file-nul') ?? '', /app\.py: baseline 1, this commit 2/);
  repo.write('sub/list.txt', '../app.py\n');
  assert.match(repo.run('git commit -m x --pathspec-from-file=list.txt', 'Bash', path.join(repo.dir, 'sub')) ?? '', /app\.py: baseline 1, this commit 2/);
  assert.equal(repo.staged(), '', 'the guard must not touch the real index');
});

test('comment ratchet: the refusal says to run the baseline command on its own before committing', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  const reason = repo.run('git commit -m "feat: total"');
  assert.match(reason, /first, as its own command/);
  assert.match(reason, /then stage and commit/);
});

test('comment ratchet: an unreadable baseline fails closed', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('.github/comment-baseline.json', '{"files": {"app.py": "one"}}');
  repo.write('app.py', `${ONE}x = 1\n`);
  repo.git('add', '-A');
  assert.match(repo.run('git commit -m "fix: x"'), /is not valid/);
});

test('comment ratchet: the hook refuses through stdin and exit code 2', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -am "feat: x"' }, cwd: repo.dir });
  const out = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^bstack guard: This commit adds comment lines over \.github\/comment-baseline\.json/);
});

test('comment ratchet: a few hundred staged files stay well inside the 90 s hook timeout', t => {
  const files = {};
  for (let k = 0; k < 400; k++) files[`src/m${k}.py`] = ONE;
  const repo = fixture(files, Object.fromEntries(Object.keys(files).map(f => [f, 1])));
  for (let k = 0; k < 400; k++) repo.write(`src/m${k}.py`, k === 399 ? TWO : `${ONE}x = ${k}\n`);
  const started = Date.now();
  const reason = repo.run('git add -A && git commit -m "feat: many"');
  const ms = Date.now() - started;
  t.diagnostic(`400 changed files checked in ${ms} ms`);
  assert.match(reason, /src\/m399\.py: baseline 1, this commit 2/);
  assert.doesNotMatch(reason, /m398/);
  assert.ok(ms < 30000, `took ${ms} ms`);
});

test('comment ratchet: interactive adds are not replayed, so no editor runs inside the guard', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  const saved = process.env.GIT_EDITOR;
  process.env.GIT_EDITOR = 'touch editor-ran';
  try {
    for (const add of ['git add -e app.py', 'git add -p', 'git add --interactive']) {
      repo.run(`${add} && git commit -m "feat: x"`);
      assert.equal(fs.existsSync(path.join(repo.dir, 'editor-ran')), false, add);
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = saved;
  }
});
