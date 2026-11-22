import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, ciState } from '../plugins/bstack/scripts/guard.mjs';
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
      return branch;
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
