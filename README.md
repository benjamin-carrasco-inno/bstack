# bstack

A gated engineering method for [Claude Code](https://code.claude.com), built for working without reading every diff yourself. The agent routes each task to a playbook with evidence gates, proves behaviour on the running app, gets an independent verdict bound to the exact head SHA, and can only merge when CI is green and that verdict exists. Hooks enforce what prose cannot hold.

Before the build, a planning layer turns ideas and bug reports into GitHub issues with acceptance criteria, so work survives between sessions and machines and an agent can take the next ticket without asking.

It is a distillation of [pstack](https://github.com/cursor/plugins/tree/main/pstack) and of the planning skills in [mattpocock/skills](https://github.com/mattpocock/skills), in its own words, rewritten for Claude Code without the Cursor-only machinery. See [NOTICE](NOTICE).

## Install

In a shell, on each machine:

```sh
claude plugin marketplace add benjamin-carrasco-inno/bstack
claude plugin install bstack@bstack
```

Then, in a Claude Code session, run `/bstack:setup`. It turns on auto-update for this marketplace (off by default for third-party marketplaces), turns off AI attribution, and checks node, git and gh. Updates then arrive on their own after each merge to `main`. The plugin has no `version` on purpose, so installs track commits.

Requirements: Node 18+ on `PATH` (the hooks are Node scripts), git, and the GitHub CLI (`gh`) logged in for the repos you work on.

## What you get

| Part | What it does |
|-|-|
| Session rules (`rules/`) | Injected at every session and subagent start by a hook, so they hold without anyone loading a skill. |
| `bstack:mode` | Router: goal, smallest change, playbook and risk tier. Playbooks: investigate, bug-fix, feature, refactor, migration, ticket, ship, autonomous-run. |
| `bstack:plan` | Sizes the work, grills you where intent is unclear, and writes a spec with ticket sub-issues, or a map of decision tickets for foggy work. Keeps `GLOSSARY.md` and ADRs. |
| `bstack:triage` | Sorts incoming issues: checks the claim, finds duplicates and work already done, writes acceptance criteria, labels the state. |
| `bstack:audit` | Review and clean up a whole repo: map, find, prove, present once, fix through small gated PRs. |
| `bstack:verify` | Run the app safely on test data and prove behaviour on the real surface. |
| `bstack:frontend` | UI rules for web apps: container-query-first layout, tokens with Automatic.css 4 names, component boundaries, basic accessibility. Ships a starter token sheet. |
| `bstack:interrogate` | Adversarial review for risky changes; findings count only when reproduced. |
| `bstack:comments` | Comment cleanup judged by a critic agent, not the author. See [Comments](#comments). |
| `bstack:correct` | Turn repeated mistakes into checks (weekly or after a revert). |
| `bstack:reviewer` agent | Fresh Sonnet agent in its own worktree. Runs the change, reads the diff, returns PASS, PASS+NOTES or FAIL for the head SHA. |
| `bstack:adversary` agent | Opus agent (Fable for large architecture changes) that tries to break tier 2 changes and reproduces what it finds. |
| `bstack:comment-critic` agent | Classifies each comment and suppression with proof; has only Read, Grep and Glob. |
| `bstack:worker` agent | Its own context for one scoped change, and for the fix rounds on it. |

## From idea to merge

```
idea or bug report -> bstack:triage or bstack:plan -> tickets (issues) -> ticket playbook -> PR -> CI + reviewer verdict -> merge -> deploy (your OK)
```

- **One PR, clear**: no plan, straight to a playbook.
- **Several PRs, clear goal**: a grilling session, then a spec issue (`plan:spec`) with one sub-issue per PR, ordered with GitHub's native blocking.
- **Foggy**: a map issue (`plan:map`) with decision tickets (`plan:research`, `plan:prototype`, `plan:grill`, `plan:task`), one decision per session, until the way is clear and a spec can be written.
- **Build**: "take the next ticket" picks the first open, unblocked, unclaimed ticket (`scripts/tracker.mjs next`), builds it as one PR with `Closes #<n>`, and the reviewer judges it against the ticket's acceptance criteria.
- Issues are kept by the agent, never by hand. Specs are temporary: once merged, the code and tests are the truth.
- `scripts/tracker.mjs labels` creates the labels a repo lacks and changes nothing else. It needs `gh` 2.94 or newer.

## What the hooks enforce

The guard runs before every `Bash` and `PowerShell` command (Windows routes shell commands through PowerShell, so a Bash-only hook would never fire there), every file write and every MCP tool call. It fails closed.

- No direct push to `main` or `master`, no `--all` or `--mirror` pushes.
- No `--no-verify`. No plain force-push (only `--force-with-lease`). No rebase of a branch that is already pushed.
- `gh pr merge` only as `--squash`, never `--auto` or `--admin`, and only when:
  - CI is green on the head SHA (no checks, or only skipped checks, is not green),
  - the risk tier, computed by `risk-tier.mjs` from the PR diff, is 0 (docs only), or
  - a reviewer verdict exists for that exact SHA and is not FAIL, and for tier 2 an interrogate result for that SHA reports zero confirmed findings.
- No merging or moving `main` through side doors: `gh api` merge and ref endpoints, the contents API on the default branch, GraphQL merge mutations, MCP merge or push tools.
- Verdicts are posted by a `SubagentStop` hook when the reviewer or adversary agent finishes, after it checks that the SHA is still the PR head. The guard blocks the verdict marker anywhere else (commands, body files, file writes), and the reviewer, adversary and comment-critic cannot commit, push or post, run `git stash`, or rewrite files or a checkout outside their own worktree and the temp dir.
- In a repo with `.github/comment-baseline.json` (written by `comments.mjs baseline`), no `git commit` whose version of a file has more comment lines than both its baseline and its previous version. The check counts the index with the `git add`, `git reset`, `git restore --staged` and `git rm --cached` earlier in the same command replayed, plus `-a` and pathspecs; it runs before the command, so a file written earlier in that command is not seen.

A new commit changes the head SHA, so an old verdict no longer counts.

### Risk tiers

- **0**: docs only. CI.
- **1**: code, config, CI, agent instructions. CI and a reviewer verdict.
- **2**: SQL that writes or changes schema, file deletion, outbound calls with side effects, mail and webhooks, concurrency, auth and importer code, `n8n/` code, and weakened checks (deleted or skipped tests, fewer assertions, new suppressions, removed CI steps). Adds interrogate, and the user's OK when a revert cannot undo it.

A repo can raise paths to tier 2 with globs in `.github/risk-paths.txt`.

## Comments

The goal is fewer comments: what a comment says becomes a better name, a check, an ADR or nothing.

- `bstack:comments` spawns the critic on a diff or paths, checks its report, and acts per class: deletes tautologies and stale comments, fixes excuses and suppressions that hide bugs, encodes constraints as checks, writes ADRs, opens issues for the rest. Only external facts with proof stay, as `external: <fact> (<proof>)`.
- `scripts/comments.mjs count` estimates comment lines and suppressions per file. The skill's first run in a repo writes `.github/comment-baseline.json` with `comments.mjs baseline` after the cleanup; later runs rewrite it when counts fell.
- The ratchet: the guard refuses a commit that adds comment lines over the baseline (see above). `bstack:audit` sends its comment findings to `bstack:comments`.

## Auditing your repos

Open one Claude Code session per repo, each in its own worktree, and ask for an audit:

```
/bstack:audit
```

The agent maps the repo, runs the existing and the stricter checks, proves each finding, presents them once ranked, then lands checks first and fixes after, as small PRs through the merge gate.

## Limits

- The gate stops forgetting, stale verdicts and side doors. It does not stop an agent determined to cheat (for example by obfuscating the marker). On a free GitHub plan, required status checks cannot be enforced server-side, so this is the enforcement layer.
- `risk-tier.mjs` is a heuristic. It errs towards higher tiers. You may treat a change as riskier, never as safer.
- Weekly quota: the reviewer runs Sonnet and the adversary Opus (Fable only for large architecture changes), only where the tier calls for them.

## Development

```sh
node --test "tests/*.test.mjs"
node tools/check-plugin.mjs
claude plugin validate .
```

Changes go through pull requests like anything else. Changes to rules and playbooks change every session, so they need the owner's OK.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
