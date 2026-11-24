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
const WINDOWS_CWD = /^[a-z]:[\\/]/i;
const onCwdHost = (input, d) => (WINDOWS_CWD.test(input.cwd ?? '') && !d.host ? { ...d, host: GIT_BASH_HOST } : d);
const blocked = (input, d = deps()) => assert.ok(decide(input, onCwdHost(input, d)), `expected block: ${JSON.stringify(input.tool_input)}`);
const allowed = (input, d = deps()) => assert.equal(decide(input, onCwdHost(input, d)), null);
const GIT_BASH_HOST = { platform: 'win32', env: {}, tmpdir: () => 'C:\\Temp' };
const onHost = (host, d = deps()) => ({ ...d, host });
const OVER_BASELINE = /app\.py: baseline 1, this commit 2/;

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

test('no-authoring agents leave checkouts outside their own cwd untouched', () => {
  const tmp = path.join(os.tmpdir(), 'repro.txt');
  for (const agent of ['bstack:comment-critic', 'bstack:reviewer', 'bstack:adversary']) {
    const as = command => ({ ...shell(command), agent_type: agent });
    const psAs = command => ({ ...ps(command), agent_type: agent });
    blocked(as('git -C /checkout stash'));
    blocked(as('git -C /checkout stash pop'));
    blocked(as('git stash push -m wip'));
    blocked(as('git -C /checkout checkout -- src/a.mjs'));
    blocked(as('git -C /checkout checkout HEAD~1 -- src/a.mjs'));
    blocked(as('git -C /checkout restore src/a.mjs'));
    blocked(as('git -C /checkout reset --hard'));
    blocked(as('git -C /checkout reset HEAD src/a.mjs'));
    blocked(as('git -C /checkout apply fix.patch'));
    blocked(as('git -C /checkout clean -fd'));
    blocked(as('git -C /checkout rm src/a.mjs'));
    blocked(as('git -C /checkout mv src/a.mjs src/b.mjs'));
    blocked(as('cd /checkout && git restore src/a.mjs'));
    blocked(as('git --work-tree /checkout checkout -- src/a.mjs'));
    blocked(as('sed -i s/a/b/ /checkout/src/a.mjs'));
    blocked(as('cd /checkout && sed -i.bak -e s/a/b/ src/a.mjs'));
    blocked(as('echo x > /checkout/src/a.mjs'));
    blocked(as('echo x >>/checkout/src/a.mjs'));
    blocked(as('echo x | tee /checkout/src/a.mjs'));
    blocked(as('rm -rf /checkout/src'));
    blocked(as('mv /checkout/src/a.mjs ./a.mjs'));
    blocked(as('cp ./a.mjs /checkout/src/a.mjs'));
    blocked(as('echo x > "$OUT"'));
    blocked(psAs('Set-Content /checkout/src/a.mjs x'));
    blocked(psAs('Set-Content -Value x -Path C:/checkout/src/a.mjs'));
    blocked(psAs('Add-Content -Path:C:/checkout/src/a.mjs -Value x'));
    blocked(psAs('"x" | Out-File -Encoding utf8 C:/checkout/src/a.mjs'));
    blocked(psAs('Remove-Item C:/checkout/src -Recurse -Force'));
    blocked(psAs('Move-Item -Path C:/checkout/src/a.mjs -Destination ./a.mjs'));
    blocked(psAs('Copy-Item ./a.mjs -Destination C:/checkout/src/a.mjs'));

    allowed(as('git stash list'));
    allowed(as('git -C /checkout stash show -p'));
    allowed(as('git -C /checkout diff'));
    allowed(as('git -C /checkout status --short'));
    allowed(as('git -C /checkout apply --check fix.patch'));
    allowed(as('git -C /checkout clean -n'));
    allowed(as('git checkout origin/main -- src/a.mjs'));
    allowed(as('git restore src/a.mjs'));
    allowed(as('git -C sub reset --hard'));
    allowed(as('node --test'));
    allowed(as('node --test 2>&1'));
    allowed(as('npm test > /dev/null 2>&1'));
    allowed(as('echo x > $null'));
    allowed(as('echo x > out.txt'));
    allowed(as('echo x > /tmp/repro.txt'));
    allowed(as('sed -i s/a/b/ src/a.mjs'));
    allowed(as('grep ">" /checkout/src/a.mjs'));
    allowed(as('cp /checkout/src/a.mjs ./a.mjs'));
    allowed(psAs('node --test 2>$null'));
    allowed(psAs('Set-Content src/a.mjs x'));
    allowed({ ...psAs(`Set-Content "${tmp}" x`), cwd: path.resolve('/repo') }, onHost({ platform: process.platform, env: {}, tmpdir: () => os.tmpdir() }));
    allowed(psAs('Set-Content $env:TEMP/repro.txt x'), onHost(GIT_BASH_HOST));
    allowed(psAs('Copy-Item -Path C:/checkout/src/a.mjs -Destination ./a.mjs'));
    allowed(psAs("Set-Content out.txt -Value @'\nx > C:/checkout/a.mjs\n'@"));
  }
  allowed(shell('git -C /checkout stash'));
  allowed(shell('git -C /checkout checkout -- src/a.mjs'));
  allowed(shell('sed -i s/a/b/ /checkout/src/a.mjs'));
  allowed(ps('Set-Content C:/checkout/src/a.mjs x'));
});

test('no-authoring agents: clobber redirects, dd, truncate, ln and .NET file writes stay inside their cwd', () => {
  for (const agent of ['bstack:comment-critic', 'bstack:reviewer', 'bstack:adversary']) {
    const as = command => ({ ...shell(command), agent_type: agent });
    const psAs = command => ({ ...ps(command), agent_type: agent });
    blocked(as('echo x >| /checkout/a.mjs'));
    blocked(as('dd if=/dev/zero of=/checkout/a.mjs bs=1 count=1'));
    blocked(as('truncate -s 0 /checkout/a.mjs'));
    blocked(as('truncate -c /checkout/a.mjs -s 0'));
    blocked(as('ln -sf ./evil.mjs /checkout/src/a.mjs'));
    blocked(as('ln -s ./evil.mjs -t /checkout/src'));
    blocked(as('ln -s ./evil.mjs --target-directory=/checkout/src'));
    blocked(psAs("[IO.File]::WriteAllText('C:/checkout/a.mjs', 'x')"));
    blocked(psAs('[System.IO.File]::AppendAllText("C:/checkout/a.mjs", "x")'));
    blocked(psAs('$null = [System.IO.File]::WriteAllBytes($p, $b)'));

    allowed(as('echo x >| out.txt'));
    allowed(as('dd if=/checkout/a.mjs of=./copy.mjs'));
    allowed(as('truncate -s 0 out.txt'));
    allowed(as('ln -s /checkout/src/a.mjs ./a.mjs'));
    allowed(as('ln -s /checkout/src/a.mjs'));
    allowed(psAs("[IO.File]::WriteAllText('C:/repo/a.mjs', 'x')"));
    allowed(psAs("[IO.File]::ReadAllText('C:/checkout/a.mjs')"));
  }
});

test('no-authoring agents do not switch, add, move or remove worktrees outside their cwd', () => {
  for (const agent of ['bstack:comment-critic', 'bstack:reviewer', 'bstack:adversary']) {
    const as = command => ({ ...shell(command), agent_type: agent });
    blocked(as('git -C /checkout switch main'));
    blocked(as('git -C /checkout checkout main'));
    blocked(as('git -C /checkout checkout -b x'));
    blocked(as('cd /checkout && git switch -c x'));
    blocked(as('git worktree remove /checkout'));
    blocked(as('git worktree remove --force /checkout'));
    blocked(as('git worktree move /checkout ./moved'));
    blocked(as('git worktree add /checkout/wt main'));
    blocked(as('git -C /checkout worktree prune'));
    blocked(as('git -C /checkout worktree add /tmp/wt'));

    allowed(as('git switch main'));
    allowed(as('git checkout -b repro'));
    allowed(as('git checkout --detach origin/main'));
    allowed(as('git worktree list'));
    allowed(as('git -C /checkout worktree list'));
    allowed(as('git worktree add /tmp/wt main'));
    allowed(as('git worktree add -b repro ./wt main'));
    allowed(as('git worktree remove /tmp/wt'));
  }
  allowed(shell('git -C /checkout switch main'));
  allowed(shell('git worktree remove /checkout'));
});

const NO_AUTHORING = ['bstack:comment-critic', 'bstack:reviewer', 'bstack:adversary'];
const asAgent = agent => command => ({ ...shell(command), agent_type: agent });
const psAsAgent = agent => command => ({ ...ps(command), agent_type: agent });

test('no-authoring agents: GIT_DIR and GIT_WORK_TREE count as a checkout outside their cwd', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(as('GIT_DIR=/checkout/.git git reset --hard'));
    blocked(as('GIT_WORK_TREE=/checkout git checkout -- a.mjs'));
    blocked(as('export GIT_WORK_TREE=/checkout; git clean -fd'));
    blocked(psAs("$env:GIT_DIR='C:/checkout/.git'; git reset --hard"));
    blocked(psAs("$env:GIT_WORK_TREE = 'C:/checkout'; git restore a.mjs"));

    allowed(as('GIT_DIR=/checkout/.git git log --oneline'));
    allowed(as('GIT_PAGER=cat git reset --hard'));
  }
  allowed(shell('GIT_DIR=/checkout/.git git reset --hard'));
});

test('no-authoring agents: only a real GIT_DIR or GIT_WORK_TREE assignment redirects git, and only where it applies', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(as('export GIT_DIR=/checkout/.git; git log; git checkout HEAD~1'));
    blocked(as('GIT_WORK_TREE=/checkout; git restore a.mjs'));
    blocked(as('cmd /c "set GIT_DIR=C:/checkout/.git && git reset --hard"'));
    blocked(psAs("$env:GIT_DIR = 'C:/checkout/.git'; git status; git checkout HEAD~1"));

    allowed(as('git grep -n GIT_DIR; git checkout HEAD~1 -- tests/guard.test.mjs'));
    allowed(as('GIT_DIR=x git log; git checkout -b tmp'));
    allowed(as('echo GIT_WORK_TREE && git restore a.mjs'));
    allowed(as("bash -c 'export GIT_DIR=/checkout/.git; git log'; git reset --hard"));
    allowed(psAs('Select-String GIT_DIR README.md; git checkout -b tmp'));
  }
});

test('no-authoring agents: a cd into the temp dir by /tmp or a temp variable stays inside the temp dir', () => {
  const host = onHost(GIT_BASH_HOST);
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    allowed(as('cd /tmp/x && git checkout HEAD~1'), host);
    allowed(as('cd /tmp && echo x > f.txt'), host);
    allowed(as('cd /tmp/x && node x.mjs > out.txt'), host);
    allowed(as("bash -c 'cd /tmp && git clone https://example.invalid/r && cd r && git checkout x'"), host);
    allowed(as('cd $TEMP && echo x > f.txt'), host);
    allowed(as('cd "${TMP}/x" && git checkout HEAD~1'), host);
    allowed(psAs('cd $env:TEMP; echo x > f.txt'), host);
    allowed(psAs('Set-Location $env:TMP/x; git checkout HEAD~1'), host);

    blocked(as('cd /tmpx && echo x > f.txt'), host);
    blocked(as('cd /tmp/../checkout && echo x > f.txt'), host);
    blocked(as('cd $TEMP/$X && echo x > f.txt'), host);
  }
});

test('no-authoring agents under Git Bash: an unset $TMPDIR is empty, not the temp dir', () => {
  const withTmpdir = onHost({ ...GIT_BASH_HOST, env: { TMPDIR: 'C:\\Temp' } });
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('cd $TMPDIR/c/repo && git -C . reset --hard'), onHost(GIT_BASH_HOST));
    blocked(as('cd $TMPDIR && rm -rf repo/plugins'), onHost(GIT_BASH_HOST));
    blocked(as('cd $TMPDIR && echo x > f.txt'), onHost(GIT_BASH_HOST));
    allowed(as('cd $TMPDIR && echo x > f.txt'), withTmpdir);
    allowed(as('cd "${TMPDIR}/x" && git checkout HEAD~1'), withTmpdir);
  }
});

test('no-authoring agents on a POSIX host: the temp dir is the environment value, and an unset variable is unresolved', () => {
  const mac = onHost({ platform: 'darwin', env: { TMPDIR: '/var/folders/xy/T' }, tmpdir: () => '/var/folders/xy/T' });
  const bare = onHost({ platform: 'linux', env: {}, tmpdir: () => '/tmp' });
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    allowed(as('cd $TMPDIR && echo x > f.txt'), mac);
    allowed(as('cd "${TMPDIR}/x" && git checkout HEAD~1'), mac);
    allowed(as('cd /tmp/x && git checkout HEAD~1'), bare);
    blocked(as('cd /tmp/x && git checkout HEAD~1'), mac);
    blocked(as('cd $TMPDIR && echo x > f.txt'), bare);
  }
});

test('no-authoring agents: repeated -C options combine like git does', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('git -C /checkout -C . reset --hard'));
    blocked(as('git -C / -C checkout reset --hard'));
    blocked(as('git -C sub -C ../.. restore a.mjs'));

    allowed(as('git -C /repo -C sub reset --hard'));
    allowed(as('git -C /checkout -C /repo/sub reset --hard'));
  }
});

test('no-authoring agents: git aliases and unknown subcommands on a checkout outside their cwd', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('git -C /checkout -c alias.wipe="reset --hard" wipe'));
    blocked(as('git -c alias.wipe="!git -C /checkout reset --hard" wipe'));
    blocked(as('git --config-env=alias.wipe=WIPE wipe'));
    blocked(as('git -C /checkout wipe'));
    blocked(as('cd /checkout && git undo'));

    allowed(as('git wipe'));
    allowed(as('git --version'));
    allowed(as('git -c core.pager=cat -C /checkout log --oneline'));
    for (const read of ['log --oneline', 'show HEAD', 'diff', 'status --short', 'rev-parse HEAD', 'blame a.mjs', 'ls-files', 'branch --show-current', 'grep x']) {
      allowed(as(`git -C /checkout ${read}`));
      allowed(as(`git ${read}`));
    }
  }
  allowed(shell('git -C /checkout wipe'));
});

test('no-authoring agents: a cd they cannot resolve makes the cwd unknown', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(psAs('cd $env:USERPROFILE; git reset --hard'));
    blocked(as('cd; git reset --hard'));
    blocked(as('cd ~ && rm -rf src'));
    blocked(psAs('Set-Location $HOME; Set-Content a.txt x'));
    blocked(as('pushd $HOME && echo x > a.txt'));

    allowed(psAs('cd $env:USERPROFILE; git status'));
    allowed(as('cd ~ && cd /repo && rm -rf src'));
    allowed(as('cd; echo x > /tmp/a.txt'));
  }
  allowed(shell('cd; git reset --hard'));
  allowed(ps('cd $env:USERPROFILE; Set-Content a.txt x'));
});

test('no-authoring agents: cmd %VAR% targets cannot be resolved', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('cmd /c "echo x > %USERPROFILE%\\a.txt"'));
    blocked(as('del %USERPROFILE%\\a.txt'));
    blocked(as('cd %USERPROFILE% && git reset --hard'));

    allowed(as('echo 100% > out.txt'));
  }
});

test('no-authoring agents: abbreviated PowerShell parameter names', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(psAs('Set-Content -Lit C:/checkout/a.mjs x'));
    blocked(psAs('Set-Content -L C:/checkout/a.mjs x'));
    blocked(psAs('Set-Content -Pa C:/checkout/a.mjs -Va x'));
    blocked(psAs('Set-Content -Fo C:/checkout/a.mjs x'));
    blocked(psAs('Out-File -File C:/checkout/a.mjs -InputObject x'));
    blocked(psAs('Copy-Item ./a.mjs -Dest C:/checkout/a.mjs'));
    blocked(psAs('Remove-Item -Lit C:/checkout/a.mjs'));
    blocked(as('cp -d ./a.mjs /checkout/a.mjs'));
    blocked(as('cp -l ./a.mjs /checkout/a.mjs'));

    allowed(psAs('Set-Content -Lit ./a.mjs x'));
    allowed(psAs('Copy-Item -Pa C:/checkout/a.mjs -Dest ./a.mjs'));
    allowed(psAs('Set-Content -Path out.txt -Value $content'));
    allowed(psAs('Set-Content out.txt $content'));
  }
});

test('no-authoring agents: cp -t and --target-directory name the destination', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('cp -t /checkout/src ./a.mjs'));
    blocked(as('cp --target-directory=/checkout/src ./a.mjs'));
    blocked(as('cp -t /checkout/src -- ./a.mjs'));

    allowed(as('cp -t ./copy /checkout/src/a.mjs'));
  }
});

test('no-authoring agents: escaped .. in a target cannot hide a path outside their cwd', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(psAs('Set-Content .`./checkout/a.mjs x'));
    blocked(psAs('Remove-Item C:/repo/.`./checkout -Recurse'));
    blocked(as('rm -rf .\\./checkout'));
    blocked(as('echo x > .\\./checkout/a.mjs'));
    blocked(as('git -C .\\. reset --hard'));
    blocked(psAs("Set-Content @('C:/checkout/a.mjs') x"));

    allowed(as('rm -rf ./build'));
    allowed(psAs('Set-Content src\\a.mjs x'));
  }
});

test('no-authoring agents: more tree-rewriting git and file writers', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    blocked(as('git -C /checkout pull'));
    blocked(as('git -C /checkout read-tree HEAD'));
    blocked(as('git -C /checkout checkout-index -a -f'));
    blocked(as('git -C /checkout update-index --assume-unchanged a.mjs'));
    blocked(psAs('Rename-Item C:/checkout/a.mjs b.mjs'));
    blocked(psAs('ren C:/checkout/a.mjs b.mjs'));
    blocked(psAs('Clear-Content C:/checkout/a.mjs'));
    blocked(as('mkdir -p /checkout/new'));
    blocked(psAs('md C:/checkout/new'));
    blocked(as('xcopy ./a.mjs C:\\checkout\\ /Y'), onHost(GIT_BASH_HOST));
    blocked(as('robocopy ./src C:/checkout/src /MIR'), onHost(GIT_BASH_HOST));
    blocked(as('curl -o /checkout/a.mjs https://example.com/a'));
    blocked(as('curl -sSLo /checkout/a.mjs https://example.com/a'));
    blocked(as('curl --output=/checkout/a.mjs https://example.com/a'));
    blocked(as('patch -d /checkout -p1 -i fix.patch'));
    blocked(as('patch /checkout/a.mjs fix.patch'));
    blocked(as('cd /checkout && patch -p1 < fix.patch'));

    allowed(as('git pull'));
    allowed(as('git update-index --refresh'));
    allowed(psAs('Rename-Item ./a.mjs b.mjs'));
    allowed(as('mkdir -p ./out'));
    allowed(as('xcopy C:\\checkout\\a.mjs ./copy /Y'), onHost(GIT_BASH_HOST));
    allowed(as('curl -o ./a.html https://example.com/a'));
    allowed(as('curl https://example.com/a'));
    allowed(as('patch -p1 -i fix.patch'));
  }
  allowed(shell('git -C /checkout pull'));
  allowed(ps('Clear-Content C:/checkout/a.mjs'));
});

test('an escaped > before | still pipes into the next command', () => {
  for (const agent of ['', ...NO_AUTHORING]) {
    const as = command => ({ ...shell(command), agent_type: agent });
    const psAs = command => ({ ...ps(command), agent_type: agent });
    blocked(as('echo \\>|git push origin main'));
    blocked(psAs('echo `>|git push origin main'));
    blocked(as('cmd /c "echo ^>|git push origin main"'));
    blocked(as('echo \\>|gh pr merge 5 --squash'));
  }
});

test('no-authoring agents: a clobber redirect >| names the next word as its target', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('echo x >| /checkout/a.mjs'));
    blocked(as('echo x >|/checkout/a.mjs'));
    blocked(as('echo x 2>| /checkout/err.txt'));
    blocked(as('echo x >| /checkout/a.mjs; echo done'));
    blocked(as('echo x >|git push origin main'));

    allowed(as('echo x >| out.txt'));
    allowed(as('echo x 2>| /tmp/err.txt'));
    allowed(as('echo \\>|cat'));
  }
});

test('no-authoring agents: heredoc bodies are text, not redirects', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    allowed(as("cat > /tmp/repro.mjs <<'EOF'\nconst out = cases.map(c => decide(c));\nEOF\nnode /tmp/repro.mjs"));
    allowed(as("cat <<'EOF' | node --input-type=module\nconsole.log([1].map(x => String(x)));\nEOF"));
    allowed(as('cat > /tmp/f.mjs <<EOF\nconst f = x => `${x}`;\nEOF'));
    allowed(as("cat <<-'A' > /tmp/a.txt\n\tx => y\n\tA\ncat <<B\nz > w(1)\nB"));

    blocked(as("cat > /checkout/a.mjs <<'EOF'\nx\nEOF"));
    blocked(as("cat <<'EOF'\nx => y\nEOF\necho x > /checkout/a.mjs"));
    blocked(as("bash <<'EOF'\necho x > /checkout/a.mjs\nEOF"));
    blocked(as("cat <<'EOF' | sh\necho x > /checkout/a.mjs\nEOF"));
  }
});

test('no-authoring agents: a << that opens no heredoc hides none of the lines after it', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    blocked(as('echo $((1<<2))\ngit -C /checkout reset --hard'));
    blocked(as('echo $((1<<2))\nrm -rf /checkout/plugins'));
    blocked(as('echo "\n1 <<X\n"\necho pwned > /checkout/README.md'));
    blocked(as('cat <<NOPE\necho pwned > /checkout/README.md'));
  }
});

test('no-authoring agents: git lines in a heredoc body are text, unless a shell runs them', () => {
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    allowed(as("cat > /tmp/fx.sh <<'EOF'\ncd \"$1\"\ngit checkout -q -b feat\nEOF"));
    allowed(as("cat > /tmp/notes.txt <<'EOF'\ngit stash\nEOF"));
    allowed(as("cat > /tmp/fx.sh <<'EOF'\ngit -C \"$1\" switch -c feat\nEOF"));
    allowed(as("cat > /tmp/fx.sh <<'EOF'\ngit -C /some/other/repo reset --hard\nEOF"));
    allowed(as("cat > /tmp/fx.sh <<'EOF'\ngit -c alias.x=status x\nEOF"));

    blocked(as("bash <<'EOF'\ngit -C /other reset --hard\nEOF"));
    blocked(as("cat <<'EOF' | sh\ngit stash\nEOF"));
  }
});

test('no-authoring agents: Git Bash drive paths /c/... are the Windows drive', () => {
  for (const agent of NO_AUTHORING) {
    const at = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\work\\wt', agent_type: agent });
    allowed(at('git -C /c/work/wt checkout --detach HEAD~1'));
    allowed(at('git diff > /c/work/wt/x.diff'));
    allowed(at('cd /c/work/wt && git reset --hard'));

    blocked(at('git -C /c/work/other checkout --detach HEAD~1'));
    blocked(at('git diff > /d/work/wt/x.diff'));
    blocked(at('cd /c/work && git reset --hard'));

    allowed(at('git diff > /c/Temp/x.diff'));
  }
});

const psAt = (command, extra = {}) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: 'C:\\repo', ...extra });
const bashAt = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\repo', ...extra });
const BASH_TEMP_RAT = path.join(os.tmpdir(), 'rat');

function onMainAt(dir) {
  return { ...deps(), git: (cwd, args) => (args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? (cwd === dir ? 'main' : 'feat/x') : '') };
}

function overBaselineAt(dir) {
  const blob = 'c'.repeat(40);
  const answers = {
    'rev-parse --show-toplevel --git-path index': `${dir}\n.git/index\n`,
    'cat-file -e :.github/comment-baseline.json': '',
    'show :.github/comment-baseline.json': '{"files":{"app.py":1}}',
    'diff --cached --raw -z -M --no-color': `:000000 100644 ${'0'.repeat(40)} ${blob} A\0app.py\0`,
    'cat-file --batch': Buffer.from(`${blob} blob ${TWO.length}\n${TWO}\n`),
  };
  return {
    ...deps(),
    exists: () => false,
    git: (cwd, args) => {
      const answer = answers[args.join(' ')];
      if (cwd !== dir || answer === undefined) throw new Error(`not a git repository: ${cwd}`);
      return answer;
    },
  };
}

function pushedAt(dir) {
  return {
    ...deps(),
    git: (cwd, args) => {
      if (cwd !== dir) throw new Error(`not a git repository: ${cwd}`);
      return args.includes('@{u}') ? 'origin/feat/x' : 'feat/x';
    },
  };
}

const LINUX_HOST = { platform: 'linux', env: {}, tmpdir: () => '/tmp' };
const GIT_BASH_DRIVE_PATH = /^\/([a-z])(\/.*)?$/i;

function resolvedOnMain(host, cwd, p, tool) {
  if (host.platform !== 'win32') return path.posix.resolve(cwd, p);
  const drive = tool === 'Bash' && GIT_BASH_DRIVE_PATH.exec(p);
  return drive ? path.win32.resolve(`${drive[1].toUpperCase()}:/${drive[2] ?? ''}`) : path.win32.resolve(cwd, p);
}

const HOST_PATH_CASES = [
  { host: LINUX_HOST, cwd: '/home/u/repo', tools: ['Bash', 'PowerShell'], paths: ['//home/u/wt', '/home/u/wt', '../wt'] },
  { host: GIT_BASH_HOST, cwd: 'C:\\repo', tools: ['Bash'], paths: ['C:\\wt', '\\\\srv\\share\\wt', '../wt', '/c/wt'] },
  { host: GIT_BASH_HOST, cwd: 'C:\\repo', tools: ['PowerShell'], paths: ['C:\\wt', '\\\\srv\\share\\wt', '../wt', '/wt'] },
];
const FULLY_ABSOLUTE = /^([a-z]:[\\/]|\\\\)|^\/(?!\/)/i;

for (const { host, cwd, tools, paths } of HOST_PATH_CASES) {
  for (const tool of tools) {
    for (const p of paths) {
      const label = `${host.platform} ${tool} ${p}`;
      test(`main session rules resolve ${label} the way the host resolves it`, () => {
        const at = command => ({ tool_name: tool, tool_input: { command }, cwd });
        const on = d => onHost(host, d);
        const dir = resolvedOnMain(host, cwd, p, tool);
        const file = resolvedOnMain(host, cwd, `${p}/v.md`, tool);
        assert.ok(decide(at(`git -C '${p}' push`), on(onMainAt(dir))), `push ${label}`);
        assert.equal(decide(at(`git -C '${p}' push`), on(onMainAt(`${dir}-other`))), null, `push elsewhere ${label}`);
        assert.ok(decide(at(`git -C '${p}' rebase origin/main`), on(pushedAt(dir))), `rebase ${label}`);
        const verdictAt = { ...deps(), readFile: f => (f === file ? `bstack-verdict: PASS sha=${SHA}` : null) };
        assert.ok(decide(at(`gh pr comment 5 --body-file '${p}/v.md'`), on(verdictAt)), `body-file ${label}`);
        assert.match(decide(at(`cd '${p}'; git commit -m x`), on(overBaselineAt(dir))) ?? '', OVER_BASELINE, `cd ${label}`);
        const afterUnknown = decide(at(`cd $X; cd '${p}'; git commit -m x`), on(overBaselineAt(dir))) ?? '';
        const absolute = host.platform === 'win32' ? FULLY_ABSOLUTE.test(p) && (tool === 'Bash' || !/^\/(?!\/)/.test(p)) : p.startsWith('/');
        assert.match(afterUnknown, absolute ? OVER_BASELINE : /cannot tell which repository/, `cd after unknown ${label}`);
        assert.match(decide(at(`git -C '${p}' commit -m x`), on(overBaselineAt(dir))) ?? '', OVER_BASELINE, `-C ${label}`);
      });
    }
  }
}

test('PowerShell reads /x as the root of the current drive, not as a Git Bash path', () => {
  blocked(psAt('git -C /c/proj push'), onMainAt('C:\\c\\proj'));
  allowed(psAt('git -C /c/proj push'), onMainAt('C:\\proj'));
  blocked(psAt('cd /tmp/rat; git commit -m x'), overBaselineAt('C:\\tmp\\rat'));
  allowed(psAt('cd /tmp/rat; git commit -m x'), overBaselineAt(BASH_TEMP_RAT));
  const verdictAt = file => ({ ...deps(), readFile: f => (f === file ? `bstack-verdict: PASS sha=${SHA}` : null) });
  blocked(psAt('gh pr comment 5 --body-file /c/x/v.md'), verdictAt('C:\\c\\x\\v.md'));
  allowed(psAt('gh pr comment 5 --body-file /c/x/v.md'), verdictAt('C:\\x\\v.md'));
  blocked(psAt('cmd /c git -C /c/proj push'), onMainAt('C:\\c\\proj'));
});

test('Bash keeps the Git Bash meaning of /c/... and /tmp; a cd to $TEMP or $TMP is unknown', () => {
  blocked(bashAt('git -C /c/proj push'), onMainAt('C:\\proj'));
  allowed(bashAt('git -C /c/proj push'), onMainAt('C:\\c\\proj'));
  assert.match(decide(bashAt('cd /tmp/rat; git commit -m x'), onHost(GIT_BASH_HOST, overBaselineAt('C:\\Temp\\rat'))) ?? '', OVER_BASELINE);
  for (const command of ['cd $TMP/rat; git commit -m x', 'pushd ${TEMP}/rat; git commit -m x']) {
    assert.match(decide(bashAt(command), onHost(GIT_BASH_HOST, overBaselineAt('C:\\Temp\\rat'))) ?? '', /cannot tell which repository/, command);
  }
  const verdictAt = file => ({ ...deps(), readFile: f => (f === file ? `bstack-verdict: PASS sha=${SHA}` : null) });
  blocked(bashAt('gh pr comment 5 --body-file /c/x/v.md'), verdictAt('C:\\x\\v.md'));
  blocked(psAt("bash -c 'git -C /c/proj push'"), onMainAt('C:\\proj'));
});

test('the main session reads a cd to $TMPDIR as unknown, set or not', () => {
  assert.match(decide(bashAt('cd $TMPDIR/c/rat; git commit -m x'), onHost(GIT_BASH_HOST, overBaselineAt('C:\\rat'))) ?? '', /cannot tell which repository/);
  const withTmpdir = { ...GIT_BASH_HOST, env: { TMPDIR: 'C:\\Temp' } };
  assert.match(decide(bashAt('cd $TMPDIR/rat; git commit -m x'), onHost(withTmpdir, overBaselineAt('C:\\Temp\\rat'))) ?? '', /cannot tell which repository/);
});

test('on a POSIX host /tmp is /tmp, and the main session reads a temp variable as unresolved', () => {
  const posixAt = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/home/u' });
  const mac = { platform: 'darwin', env: { TMPDIR: '/var/folders/xy/T' }, tmpdir: () => '/var/folders/xy/T' };
  for (const command of ['cd /tmp/repo && git commit -m x', 'pushd /tmp/repo; git commit -m x', 'cd /tmp && cd repo && git commit -m x']) {
    assert.match(decide(posixAt(command), onHost(mac, overBaselineAt('/tmp/repo'))) ?? '', OVER_BASELINE, command);
  }
  for (const command of ['cd $TMPDIR/repo && git commit -m x', 'cd "${TMPDIR}/repo"; git commit -m x']) {
    assert.match(decide(posixAt(command), onHost(mac, overBaselineAt('/var/folders/xy/T/repo'))) ?? '', /cannot tell which repository/, command);
  }
  const linux = { platform: 'linux', env: {}, tmpdir: () => '/tmp' };
  for (const command of ['cd $TMPDIR/repo && git commit -m x', 'cd $TEMP/repo; git commit -m x']) {
    assert.match(decide(posixAt(command), onHost(linux, overBaselineAt('/tmp/repo'))) ?? '', /cannot tell which repository/, command);
  }
  const pwsh = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/home/u' });
  assert.match(decide(pwsh('cd $env:TMP/repo; git commit -m x'), onHost({ ...linux, env: { TMP: '/tmp' } }, overBaselineAt('/tmp/repo'))) ?? '', /cannot tell which repository/);
  assert.match(decide(pwsh('cd $env:TMP/repo; git commit -m x'), onHost(linux, overBaselineAt('/tmp/repo'))) ?? '', /cannot tell which repository/);
});

test('comment ratchet: a temp variable assigned earlier in the line is unresolved, not the temp dir', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  const bashDir = repo.dir.replace(/\\/g, '/');
  const lines = [
    [`$env:TEMP = '${repo.dir}'; cd $env:TEMP; git commit -m x`, 'PowerShell'],
    [`$env:TMP = '${repo.dir}'; Set-Location $env:TMP; git commit -m x`, 'PowerShell'],
    [`export TMPDIR='${bashDir}'; cd "$TMPDIR" && git commit -m x`, 'Bash'],
    [`TEMP='${bashDir}'; cd $TEMP; git commit -m x`, 'Bash'],
  ];
  for (const [line, tool] of lines) assert.match(repo.run(line, tool) ?? '', /cannot tell which repository/, line);
});

test('no-authoring agents: a temp variable assigned earlier in the line is not the temp dir', () => {
  for (const agent of NO_AUTHORING) {
    const psAs = command => psAt(command, { agent_type: agent });
    const as = command => bashAt(command, { agent_type: agent });
    blocked(psAs("$env:TEMP='C:\\other\\checkout'; cd $env:TEMP; git checkout -- ."), onHost(GIT_BASH_HOST));
    blocked(psAs("$env:TEMP='C:\\other\\checkout'; Set-Content $env:TEMP\\app.js x"), onHost(GIT_BASH_HOST));
    blocked(psAs("$env:TMP='C:\\other\\checkout'; Set-Location $env:TMP; git reset --hard"), onHost(GIT_BASH_HOST));
    blocked(as('export TMPDIR=/c/other/checkout; cd "$TMPDIR" && git checkout -- .'), onHost(GIT_BASH_HOST));
    blocked(as('TEMP=/c/other/checkout; echo x > $TEMP/app.js'), onHost(GIT_BASH_HOST));
    allowed(psAs('cd $env:TEMP; git checkout -- .'), onHost(GIT_BASH_HOST));
  }
});

test('comment ratchet: the main session never reads a temp variable as the temp dir, however it was set', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  const bashDir = repo.dir.replace(/\\/g, '/');
  const sub = path.relative(os.tmpdir(), repo.dir);
  const lines = [
    [`Set-Item env:TEMP '${repo.dir}'; cd $env:TEMP; git commit -m x`, 'PowerShell'],
    [`$env:TEMP += '\\${sub}'; cd $env:TEMP; git commit -m x`, 'PowerShell'],
    [`[Environment]::SetEnvironmentVariable('TMP', '${repo.dir}'); Set-Location $env:TMP; git commit -m x`, 'PowerShell'],
    ['cd $env:TEMP; git commit -m x', 'PowerShell'],
    [`declare -x TEMP=${bashDir}; cd $TEMP && git commit -m x`, 'Bash'],
    [`readonly TMP=${bashDir}; cd $TMP && git commit -m x`, 'Bash'],
    [`cd \${TMP/tmp/${bashDir.replace(/\//g, '\\/')}} && git commit -m x`, 'Bash'],
    ['cd $TEMP && git commit -m x', 'Bash'],
  ];
  for (const [line, tool] of lines) {
    assert.match(repo.run(line, tool) ?? '', /cannot tell which repository/, line);
    assert.match(repo.run(line, tool, os.tmpdir()) ?? '', /cannot tell which repository/, `${line} (from the temp dir)`);
  }
});

test('no-authoring agents: a temp variable is the temp dir only when every mention of it in the line is a plain read', () => {
  for (const agent of NO_AUTHORING) {
    const psAs = command => psAt(command, { agent_type: agent });
    const as = command => bashAt(command, { agent_type: agent });
    const host = onHost(GIT_BASH_HOST);
    blocked(psAs("Set-Item env:TEMP 'C:\\other\\checkout'; cd $env:TEMP; git checkout -- ."), host);
    blocked(psAs("$env:TEMP += '\\..\\..\\other'; cd $env:TEMP; git reset --hard"), host);
    blocked(psAs("$env:TEMP += 'x'; Set-Content $env:TEMP\\app.js x"), host);
    blocked(psAs("[Environment]::SetEnvironmentVariable('TMP', 'C:\\other'); Set-Location $env:TMP; git reset --hard"), host);
    blocked(psAs("${env:TEMP} = 'C:\\other'; cd $env:TEMP; git reset --hard"), host);
    blocked(as('declare -x TEMP=/c/other/checkout; cd $TEMP && git checkout -- .'), host);
    blocked(as('readonly TMP=/c/other; cd $TMP && echo x > f.txt'), host);
    blocked(as('cd ${TMP/Temp/other} && git reset --hard'), host);
    blocked(as('cd ${TMP:-/c/other} && git reset --hard'), host);
    blocked(as('typeset TEMP=/c/other; echo x > $TEMP/app.js'), host);

    allowed(psAs('cd $env:TEMP; echo x > f.txt'), host);
    allowed(as('echo x > $TMP/a'), host);
    allowed(as("cat > $TEMP/x.sh <<'EOF'\necho hi\nEOF"), host);
    allowed(as('cd "${TEMP}/x" && git checkout HEAD~1'), host);
  }
});

test('set assigns a variable in cmd, and any mention of TEMP besides a plain read leaves $TEMP unresolved', () => {
  for (const agent of NO_AUTHORING) {
    const as = command => bashAt(command, { agent_type: agent });
    blocked(as('set TEMP=/c/other/checkout; cd $TEMP && echo x > f.txt'), onHost(GIT_BASH_HOST));
    blocked(as('cmd /c "set GIT_DIR=C:/checkout/.git && git reset --hard"'));
  }
});

test('no-authoring agents under PowerShell: /tmp is C:\\tmp, the temp dir is $env:TEMP', () => {
  for (const agent of NO_AUTHORING) {
    const psAs = command => psAt(command, { agent_type: agent });
    const as = command => bashAt(command, { agent_type: agent });
    blocked(psAs('Set-Content /tmp/notes.txt x'), onHost(GIT_BASH_HOST));
    blocked(psAs('cd /tmp; Set-Content notes.txt x'), onHost(GIT_BASH_HOST));
    blocked(psAs('Set-Content $TMPDIR/notes.txt x'), onHost(GIT_BASH_HOST));
    allowed(psAs('Set-Content $env:TEMP/notes.txt x'), onHost(GIT_BASH_HOST));
    allowed(psAs('Set-Content /repo/notes.txt x'), onHost(GIT_BASH_HOST));
    allowed(as('echo x > /tmp/notes.txt'), onHost(GIT_BASH_HOST));
    allowed(as('cd /tmp && echo x > notes.txt'), onHost(GIT_BASH_HOST));
    blocked(as('echo x > $env:TEMP/notes.txt'), onHost(GIT_BASH_HOST));
  }
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
  assert.match(ciState([run('standards', 'CANCELLED', '2026-11-23T10:00:00Z'), run('standards', null, '2026-11-23T10:01:00Z', 'IN_PROGRESS')]).detail, /failed: standards/);
  assert.match(ciState([run('lint', 'SUCCESS', '2026-11-23T10:01:00Z'), run('standards', 'CANCELLED', '2026-11-23T10:00:00Z')]).detail, /failed: standards/);
});

test('ciState keeps an older failure when a newer run of the check is skipped or neutral', () => {
  for (const later of ['SKIPPED', 'NEUTRAL']) {
    const rollup = [run('test', 'FAILURE', '2026-11-23T10:00:00Z'), run('test', later, '2026-11-23T10:01:00Z')];
    assert.match(ciState(rollup).detail, /failed: test/, later);
  }
});

test('ciState keeps a newer queued run pending even after an older success', () => {
  for (const startedAt of [null, '0001-01-01T00:00:00Z']) {
    const rollup = [run('test', 'SUCCESS', '2026-11-23T10:00:00Z'), run('test', null, startedAt, 'QUEUED')];
    assert.match(ciState(rollup).detail, /still running: test/, String(startedAt));
  }
});

test('ciState drops a cancelled run only for a strictly newer success of the same check', () => {
  assert.match(ciState([run('test', 'CANCELLED', '2026-11-23T10:00:00Z'), run('test', 'SUCCESS', '2026-11-23T10:00:00Z')]).detail, /failed: test/);
  assert.match(ciState([run('test', 'CANCELLED', null), run('test', 'SUCCESS', '2026-11-23T10:00:00Z')]).detail, /failed: test/);
  assert.match(ciState([run('test', 'CANCELLED', '2026-11-23T10:00:00Z'), run('test', 'FAILURE', '2026-11-23T10:01:00Z')]).detail, /failed: test/);
  assert.equal(ciState([run('test', 'CANCELLED', '2026-11-23T10:00:00Z'), run('test', 'SUCCESS', '2026-11-23T10:01:00Z')]).ok, true);
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
  blocked(shell('echo {} > ~/.claude/bstack/pending-verdicts/o_r__5.json'));
  blocked(ps(`$d = "${dir}"; Set-Content "$d\\x.json" '{}'`));
});

test('commands that only mention saved verdicts in a message are not refused', () => {
  allowed(shell('git commit -m "fix(guard): keep pending-verdicts through outages"'));
  allowed(shell('gh pr create --title "pending-verdicts" --body "The hook saves to ~/.claude/bstack/pending-verdicts/ when GitHub is down."'));
  allowed(shell('git commit --message="docs: pending-verdicts/ layout"'));
});

const savedAt = (result, at, sha = SHA) => ({ repo: 'o/r', pr: '5', sha, kind: 'verdict', at, body: commentBody('verdict', result, sha, 'report', at) });

test('a saved verdict older than a verdict already posted for the head is dropped, both ways', () => {
  const olderPass = withPending([savedAt('PASS', '2026-11-22T09:00:00Z')], { pr: { comments: [verdict('FAIL', SHA, '2026-11-22T10:00:00Z')] } });
  blocked(shell('gh pr merge 5 --squash'), olderPass.d);
  assert.deepEqual(olderPass.posted, []);
  assert.deepEqual(olderPass.removed, ['f0']);

  const olderFail = withPending([savedAt('FAIL', '2026-11-22T09:00:00Z')], { pr: { comments: [verdict('PASS', SHA, '2026-11-22T10:00:00Z')] } });
  allowed(shell('gh pr merge 5 --squash'), olderFail.d);
  assert.deepEqual(olderFail.posted, []);
  assert.deepEqual(olderFail.removed, ['f0']);
});

test('a saved verdict newer than the posted one is posted and decides the merge', () => {
  const { d, posted } = withPending([savedAt('PASS', '2026-11-22T11:00:00Z')], { pr: { comments: [verdict('FAIL', SHA, '2026-11-22T10:00:00Z')] } });
  allowed(shell('gh pr merge 5 --squash'), d);
  assert.equal(posted.length, 1);
});

test('a saved entry with an empty body is dropped, not posted', () => {
  const { d, posted, removed } = withPending([{ ...saved(), body: '' }]);
  blocked(shell('gh pr merge 5 --squash'), d);
  assert.deepEqual(posted, []);
  assert.deepEqual(removed, ['f0']);
});

test('ciState judges every status context, whatever its time', () => {
  const ctx = (state, createdAt) => ({ __typename: 'StatusContext', context: 'ci/legacy', state, createdAt });
  assert.match(ciState([ctx('SUCCESS', '2026-11-23T10:05:00Z'), ctx('FAILURE', '2026-11-23T10:00:00Z')]).detail, /failed: ci\/legacy/);
  assert.match(ciState([ctx('FAILURE', '2026-11-23T10:05:00Z'), ctx('SUCCESS', '2026-11-23T10:00:00Z')]).detail, /failed: ci\/legacy/);
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

function fixture(files, baseline, name) {
  const dir = name ? path.join(tempDir(), name) : tempDir();
  fs.mkdirSync(dir, { recursive: true });
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

test('comment ratchet: a clobber redirection (>|) is not a pathspec', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  assert.match(repo.run('git add app.py >| /dev/null; git commit -m "feat: x"') ?? '', /app\.py/);
  repo.git('add', 'app.py');
  for (const command of ['git commit -m "feat: x" >| commit.log', 'git commit -m "feat: x" 2>| err.txt', 'git commit -m "feat: x" >|commit.log']) {
    assert.match(repo.run(command) ?? '', /app\.py/, command);
  }

  const legit = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  legit.write('app.py', `${ONE}x = 1\n`);
  legit.git('add', 'app.py');
  for (const command of ['git commit -m "feat: x" >| /dev/null', 'git commit -m "feat: x" 2>| err.txt']) {
    assert.equal(legit.run(command), null, command);
  }
});

test('comment ratchet: an escaped > before | still pipes into git commit', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  assert.match(repo.run('echo \\>|git commit -m x') ?? '', /cannot see what `echo \\>` changes first/);
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
    assert.match(repo.run(line) ?? '', /in its own call/, line);
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

test('comment ratchet: --git-dir, --work-tree and GIT_DIR point the check at that repo, and an unresolved one is refused', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  const elsewhere = tempDir();
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  const gitDir = `${repo.dir}/.git`;
  const lines = [
    [`git --git-dir="${gitDir}" --work-tree="${repo.dir}" commit -m x`, 'Bash'],
    [`git --git-dir "${gitDir}" --work-tree "${repo.dir}" commit -m x`, 'Bash'],
    [`GIT_DIR="${gitDir}" GIT_WORK_TREE="${repo.dir}" git commit -m x`, 'Bash'],
    [`export GIT_DIR="${gitDir}"; git commit -m x`, 'Bash'],
    [`$env:GIT_DIR = '${gitDir}'; $env:GIT_WORK_TREE='${repo.dir}'; git commit -m x`, 'PowerShell'],
  ];
  for (const [line, tool] of lines) assert.match(repo.run(line, tool, elsewhere) ?? '', /app\.py: baseline 1, this commit 2/, line);
  for (const line of ['git --git-dir="$D" commit -m x', 'GIT_DIR=$D git commit -m x', 'GIT_INDEX_FILE=/tmp/i git commit -m x', 'cd "$D" && git commit -m x', 'git -C "$D" commit -m x']) {
    assert.match(repo.run(line, 'Bash', elsewhere) ?? '', /which repository/, line);
  }
  const clean = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  clean.write('app.py', `${ONE}x = 1\n`);
  clean.git('add', 'app.py');
  assert.equal(clean.run(`git --git-dir="${clean.dir}/.git" --work-tree="${clean.dir}" commit -m x`, 'Bash', elsewhere), null);
});

test('comment ratchet: a command before the commit that may change files or the index is refused, read-only and replayed ones are not', () => {
  const repo = fixture({ 'app.py': ONE, 'b.py': NONE }, { 'app.py': 1, 'b.py': 0 });
  repo.git('checkout', '-qb', 'more');
  repo.write('app.py', TWO);
  repo.git('commit', '-qam', 'more comments');
  repo.git('checkout', '-q', 'main');
  repo.write('fix.diff', '');
  const refused = [
    ["printf '# note\\n' >> app.py && git commit -am x", 'Bash'],
    ["echo '# note' > b.py; git commit -am x", 'PowerShell'],
    ['Add-Content b.py "# note"; git commit -am x', 'PowerShell'],
    ['git checkout more -- app.py && git commit -m x', 'Bash'],
    ['git mv app.py lib.py && git commit -m x', 'Bash'],
    ['git stash pop && git commit -m x', 'Bash'],
    ['git apply --cached fix.diff && git commit -m x', 'Bash'],
    ['git add -p && git commit -m x', 'Bash'],
    ['git reset more && git commit -m x', 'Bash'],
    ['npm run generate && git commit -am x', 'Bash'],
    ['echo $(touch b.py) && git commit -am x', 'Bash'],
    ['$env:X = git stash; git commit -am x', 'PowerShell'],
  ];
  for (const [line, tool] of refused) assert.match(repo.run(line, tool) ?? '', /in its own call/, line);
  repo.write('b.py', `${NONE}y = 2\n`);
  const allowed = [
    [`git status && git diff --stat && git log --oneline -1 | tail -1 && echo ok && cd "${repo.dir}" && git add -A && git commit -m x`, 'Bash'],
    ['git add b.py; if ($?) { git commit -m x }', 'PowerShell'],
    ['git rm -q app.py && git commit -m x', 'Bash'],
    ['git status 2>&1 > /dev/null && git commit -am x', 'Bash'],
  ];
  for (const [line, tool] of allowed) assert.equal(repo.run(line, tool), null, line);
  const plain = fixture({ 'app.py': ONE });
  assert.equal(plain.run('npm test && git commit -am x'), null, 'a repo without a baseline is not affected');
});

test('comment ratchet: a cd inside bash -c or pwsh -Command does not move the commands after it', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  const elsewhere = tempDir();
  repo.write('app.py', TWO);
  repo.git('add', 'app.py');
  assert.match(repo.run(`bash -c "cd '${elsewhere}' && git status"; git commit -m x`) ?? '', /app\.py: baseline 1/);
  assert.match(repo.run(`pwsh -Command "Set-Location '${elsewhere}'"; git commit -m x`, 'PowerShell') ?? '', /app\.py: baseline 1/);
  assert.match(repo.run(`bash -c "cd '${repo.dir}' && git commit -m x"`, 'Bash', elsewhere) ?? '', /app\.py: baseline 1/);
});

test('comment ratchet: an octopus merge allows comments from every merged head', () => {
  const repo = fixture({ 'a.py': NONE, 'b.py': NONE }, { 'a.py': 0, 'b.py': 0 });
  for (const side of ['a', 'b']) {
    repo.git('switch', '-qc', side, 'main');
    repo.write(`${side}.py`, ONE);
    repo.git('commit', '-qam', `human: comment ${side}`);
  }
  repo.git('switch', '-q', 'main');
  repo.git('merge', '--no-commit', '--no-ff', 'a', 'b');
  assert.equal(repo.run('git commit --no-edit'), null);
});

test('comment ratchet: merge, cherry-pick, revert and rebase --continue are checked like git commit', () => {
  const starts = { merge: () => ['merge', 'main'], 'cherry-pick': theirs => ['cherry-pick', theirs], rebase: () => ['rebase', 'main'] };
  for (const [sub, start] of Object.entries(starts)) {
    const repo = conflicted(start);
    assert.equal(repo.run(`git add c.py && git ${sub} --continue`), null, sub);
    repo.write('c.py', '# feature note\nc = 3\n');
    assert.match(repo.run(`git add c.py && git ${sub} --continue`) ?? '', /c\.py: baseline 0, this commit 1/, sub);
  }
  const repo = fixture({ 'app.py': NONE, 'c.py': 'c = 0\n' }, { 'app.py': 0, 'c.py': 0 });
  repo.write('c.py', 'c = 1\n');
  repo.git('commit', '-qam', 'c1');
  const target = repo.git('rev-parse', 'HEAD').trim();
  repo.write('c.py', 'c = 2\n');
  repo.git('commit', '-qam', 'c2');
  assert.throws(() => execFileSync('git', ['-C', repo.dir, 'revert', '--no-edit', target], { stdio: 'ignore' }));
  repo.write('c.py', '# note\nc = 0\n');
  assert.match(repo.run('git add c.py && git revert --continue') ?? '', /c\.py: baseline 0, this commit 1/);
});

test('comment ratchet: git am --continue is checked like git commit, and git am applying patches fails closed', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  repo.write('app.py', `${ONE}x = 1\n`);
  assert.equal(repo.run('git add app.py && git am --continue'), null);
  repo.write('app.py', TWO);
  for (const line of ['git add app.py && git am --continue', 'git add app.py && git am --resolved']) {
    assert.match(repo.run(line) ?? '', /app\.py: baseline 1, this commit 2/, line);
  }
  for (const line of ['git am 0001-x.patch', 'git am -3 < mbox', 'git am --skip']) {
    assert.match(repo.run(line) ?? '', /cannot see what git am commits/, line);
  }
  assert.equal(repo.run('git am --abort'), null);
  assert.equal(repo.run('git am --show-current-patch'), null);
  const plain = fixture({ 'app.py': ONE });
  assert.equal(plain.run('git am 0001-x.patch'), null, 'a repo without a baseline is not affected');
});

test('comment ratchet: core.worktree, GIT_COMMON_DIR and GIT_CONFIG_* are refused like GIT_INDEX_FILE', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  const lines = [
    ['git -c core.worktree=/elsewhere commit -m x', 'Bash'],
    ['git -c Core.WorkTree=/elsewhere commit -m x', 'Bash'],
    ['git --config-env=core.worktree=WT commit -m x', 'Bash'],
    ['GIT_COMMON_DIR=/elsewhere/.git git commit -m x', 'Bash'],
    ['export GIT_COMMON_DIR=/elsewhere/.git; git commit -m x', 'Bash'],
    ["GIT_CONFIG_PARAMETERS=\"'core.worktree'='/elsewhere'\" git commit -m x", 'Bash'],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/elsewhere git commit -m x', 'Bash'],
    ["$env:GIT_COMMON_DIR = 'C:/elsewhere/.git'; git commit -m x", 'PowerShell'],
    ['git -c core.worktree=/elsewhere am --continue', 'Bash'],
  ];
  for (const [line, tool] of lines) assert.match(repo.run(line, tool) ?? '', /which repository/, line);
  assert.equal(repo.run('git -c user.name=x commit -m x'), null);
});

test('comment ratchet: a commit inside a loop body is refused, a loop before or a word in a message is not', () => {
  const repo = fixture({ 'app.py': ONE }, { 'app.py': 1 });
  const refused = [
    ['while true; do git commit -m x; done', 'Bash'],
    ['until false; do git commit -m x; echo "# n" >> app.py; git add app.py; done', 'Bash'],
    ['for f in a b; do\n  git commit -m x\ndone', 'Bash'],
    ['bash -c "while true; do git commit -m x; done"', 'Bash'],
    ['while ($true) { git commit -m x }', 'PowerShell'],
    ['do { git commit -m x } while ($true)', 'PowerShell'],
    ["foreach ($f in @('a')) { git commit -m x }", 'PowerShell'],
    ['1..2 | ForEach-Object { git commit -m x }', 'PowerShell'],
    ['for ($i = 0; $i -lt 2; $i++) { git am --continue }', 'PowerShell'],
  ];
  for (const [line, tool] of refused) assert.match(repo.run(line, tool) ?? '', /in its own call/, line);
  assert.equal(repo.run('git commit -m "fix: do not loop when done"'), null);
  assert.equal(repo.run("git commit -m 'while ($x) { done }'", 'PowerShell'), null);
  const plain = fixture({ 'app.py': ONE });
  assert.equal(plain.run('while true; do git commit -m x; done'), null, 'a repo without a baseline is not affected');
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

test('an empty -C is ignored and an unresolved -C fails closed, for push, rebase and the comment ratchet', () => {
  const repo = fixture({ 'sub/app.py': NONE }, { 'sub/app.py': 0 });
  repo.git('remote', 'add', 'origin', 'https://example.invalid/r');
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.git('branch', '--set-upstream-to=origin/main');
  repo.write('sub/app.py', ONE);
  repo.git('add', '-A');
  const opaque = ['$X', '"${X}"', '%X%', '`pwd`', '"$(pwd)"'];
  for (const command of [
    'git -C "" -C sub push origin HEAD', "git -C '' -C sub push", 'git -C sub -C "" push',
    ...opaque.map(x => `git -C ${x} -C sub push`), ...opaque.map(x => `git -C ${x} push origin HEAD`),
    'git -C "" -C sub rebase origin/main', 'git -C $X -C sub rebase origin/main', 'git -C %X% pull --rebase',
  ]) assert.ok(repo.run(command), `expected block: ${command}`);
  for (const command of ['git -C "" -C sub commit -m "feat: x"', "git -C '' commit -m \"feat: x\""]) {
    assert.match(repo.run(command) ?? '', /sub\/app\.py: baseline 0, this commit 1/, command);
  }
  for (const x of opaque) assert.match(repo.run(`git -C ${x} -C sub commit -m "feat: x"`) ?? '', /cannot tell which repository/, x);
  assert.equal(repo.run('git -C "" -C sub push origin feat/x'), null);
  assert.equal(repo.run('git -C $X push origin feat/x'), null);
  assert.equal(repo.run('git -C $X -C /elsewhere push origin HEAD'), null);
});

function parenthesisRepo() {
  const repo = fixture({ 'app.py': NONE }, { 'app.py': 0 }, 'x (1)');
  repo.git('remote', 'add', 'origin', 'https://example.invalid/r');
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/feat/x', 'HEAD');
  repo.git('checkout', '-q', '-b', 'feat/x');
  repo.git('branch', '--set-upstream-to=origin/main');
  return repo;
}

test('a quoted -C path with a parenthesis is literal for push, commit, rebase and pull --rebase, under Bash and PowerShell', () => {
  const repo = parenthesisRepo();
  for (const tool of ['Bash', 'PowerShell']) {
    for (const quoted of [`"${repo.dir}"`, `'${repo.dir}'`]) {
      for (const sub of ['push origin HEAD', 'rebase origin/main', 'pull --rebase']) {
        assert.equal(repo.run(`git -C ${quoted} ${sub}`, tool, os.tmpdir()), null, `${tool}: git -C ${quoted} ${sub}`);
      }
      repo.write('app.py', ONE);
      repo.git('add', '-A');
      assert.match(repo.run(`git -C ${quoted} commit -m "feat: x"`, tool, os.tmpdir()) ?? '', /app\.py: baseline 0, this commit 1/, `${tool}: ${quoted}`);
      repo.git('reset', '-q', '--hard');
    }
  }
  repo.git('branch', '--set-upstream-to=origin/feat/x');
  for (const tool of ['Bash', 'PowerShell']) {
    assert.match(repo.run(`git -C "${repo.dir}" rebase origin/main`, tool, os.tmpdir()) ?? '', /feat\/x is already pushed/, tool);
    assert.match(repo.run(`git -C "${repo.dir}" pull --rebase`, tool, os.tmpdir()) ?? '', /feat\/x is already pushed/, tool);
  }
});

test('a -C path that is an expression stays unresolved: $(...), @(...) and an unquoted ( inside a word', () => {
  const repo = parenthesisRepo();
  repo.write('app.py', ONE);
  repo.git('add', '-A');
  const unquoted = repo.dir.replace(' (1)', '(1)');
  for (const dir of ['$(pwd)', '"$(pwd)"', '@(Get-Location)', unquoted]) {
    for (const sub of ['push origin HEAD', 'rebase origin/main', 'pull --rebase']) {
      assert.match(repo.run(`git -C ${dir} ${sub}`, 'PowerShell', os.tmpdir()) ?? '', /not literal/, `git -C ${dir} ${sub}`);
    }
    assert.match(repo.run(`git -C ${dir} commit -m "feat: x"`, 'PowerShell', os.tmpdir()) ?? '', /cannot tell which repository/, dir);
  }
});

test('no-authoring agents: a quoted cd or -C into a temp dir with a parenthesis stays inside the temp dir', () => {
  const dir = path.join(tempDir(), 'x (1)');
  for (const agent of NO_AUTHORING) {
    for (const tool of ['Bash', 'PowerShell']) {
      const at = command => ({ tool_name: tool, tool_input: { command }, cwd: '/repo', agent_type: agent });
      allowed(at(`cd "${dir}" && git checkout HEAD~1`));
      allowed(at(`git -C "${dir}" checkout HEAD~1`));
      allowed(at(`cd '${dir}'; git reset --hard`));
    }
    const psAs = command => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', agent_type: agent });
    blocked(psAs(`cd ${dir.replace(' (1)', '(1)')}; git checkout HEAD~1`));
    blocked(psAs(`git -C ${dir.replace(' (1)', '(1)')} checkout HEAD~1`));
    blocked(psAs('git -C @(Get-Location) checkout HEAD~1'));
  }
});

test('no-authoring agents: a quoted write target with a parenthesis is a literal path', () => {
  const temp = path.join(tempDir(), 'x (1)', 'a.txt');
  for (const agent of NO_AUTHORING) {
    const as = asAgent(agent);
    const psAs = psAsAgent(agent);
    allowed(as('echo x > "notes (1).txt"'));
    allowed(as("echo x >| 'notes (1).txt'"));
    allowed(as('cp /tmp/fixture.tsx "app/(marketing)/page.tsx"'));
    allowed(as('rm "app/(marketing)/tmp.txt"'));
    allowed(as(`sed -i 's/a/b/' "src/routes/(app)/+page.svelte"`));
    allowed(as('git worktree add "wt (1)" main'));
    allowed({ tool_name: 'PowerShell', tool_input: { command: `Set-Content -LiteralPath "${temp}" -Value x` }, cwd: '/repo', agent_type: agent });
    allowed(psAs("Remove-Item -LiteralPath 'app\\(marketing)\\tmp.txt'"));
    allowed(psAs('[IO.File]::WriteAllText("notes (1).txt", "x")'));

    blocked(as('echo x > notes(1).txt'));
    blocked(as('rm app/x(1)/tmp.txt'));
    blocked(as('echo x > "$(pwd)/a.txt"'));
    blocked(as('git worktree add wt(1) main'));
    blocked(psAs('Remove-Item x(1)'));
    blocked(psAs("Remove-Item @('a.txt')"));
    blocked(psAs('[IO.File]::WriteAllText(x(1).txt, "x")'));

    blocked(as('echo x > "/checkout/notes (1).txt"'));
    blocked(as('cp /tmp/fixture.tsx "/checkout/app/(marketing)/page.tsx"'));
    blocked(as('rm "/checkout/app/(marketing)/tmp.txt"'));
    blocked(as(`sed -i 's/a/b/' "/checkout/src/routes/(app)/+page.svelte"`));
    blocked(psAs('Set-Content -LiteralPath "C:/checkout/x (1)/a.txt" -Value x'));
    blocked(psAs("Remove-Item -LiteralPath 'C:\\checkout\\app\\(marketing)\\tmp.txt'"));
  }
});