import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, ciState, realDeps } from '../plugins/bstack/scripts/guard.mjs';
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
    allowed(psAs(`Set-Content "${tmp}" x`));
    allowed(psAs('Set-Content $env:TEMP/repro.txt x'));
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
    blocked(as('xcopy ./a.mjs C:\\checkout\\ /Y'));
    blocked(as('robocopy ./src C:/checkout/src /MIR'));
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
    allowed(as('xcopy C:\\checkout\\a.mjs ./copy /Y'));
    allowed(as('curl -o ./a.html https://example.com/a'));
    allowed(as('curl https://example.com/a'));
    allowed(as('patch -p1 -i fix.patch'));
  }
  allowed(shell('git -C /checkout pull'));
  allowed(ps('Clear-Content C:/checkout/a.mjs'));
});

test('ciState treats skipped-only and missing checks as not green', () => {
  assert.equal(ciState([]).ok, false);
  assert.equal(ciState([{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }]).ok, false);
  assert.equal(ciState([{ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }]).ok, true);
  assert.equal(ciState(GREEN).ok, true);
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
