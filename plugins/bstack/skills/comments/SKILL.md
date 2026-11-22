---
name: comments
description: Clean up comments without letting the author judge them. Spawns the bstack:comment-critic agent on a scope, checks its report, deletes tautologies and stale comments, turns real decisions into ADRs, and keeps external ones only with proof. Use for "ryd op i kommentarer", "comments", or comment findings in a review or audit.
---

# Comments

**Goal:** fewer comments. What a comment said becomes a better name, a check, an ADR or nothing. Only external facts with proof stay.

## 1. Scope

- No argument: the diff against the base branch, including the working tree (`git diff $(git merge-base origin/<base> HEAD)`) and untracked files (`git ls-files --others --exclude-standard`).
- Paths, or "the whole repo": those files.

For a diff, the comments in scope are those it adds or changes, plus existing ones in the changed files that name code the diff changes or removes (a code change can make an unchanged comment stale). Give the critic this definition with the scope.

Record now, in the checkout: the output of `node "${CLAUDE_PLUGIN_ROOT}/scripts/fingerprint.mjs"` (HEAD and a content hash of every tracked and untracked file, ending in a `fingerprint:` line), and the result of the repo's tests and linters.

## 2. Spawn the critic

Spawn `bstack:comment-critic` with only the checkout path and the scope. Not your view of the comments. It must form its own.

## 3. Check the report

The report is accepted only when every check holds:
- The fingerprint is unchanged: the script exits 0 both times and the `fingerprint:` lines are equal, so the critic edited nothing. A non-zero exit rejects the report.
- Every line has five fields and a class with an action it allows: tautology and stale `delete`; excuse `fix` or `issue`; a suppression of any class also `fix`; decision `adr` or `delete`; constraint `encode` or `issue`; external `keep`.
- Every line has proof, and the file and line hold a comment in scope as step 1 defines it.
- No comment in scope is missing: compare against a search for the comment markers in the scope's files.
- Every `keep` is external, and its proof holds when you check it again: run the command, or open the link and find the pinned version in the repo.
- Every `adr` meets all three parts of the ADR bar in `bstack:plan` (hard to reverse, surprising without context, a real trade-off). A decision that fails one is deleted.

A rejected report gets **one** rerun: a fresh critic with the scope and the failed lines, each with the check it failed. If the rerun is rejected too, the skill fails: act on nothing and report every comment in scope as open.

## 4. Act on an accepted report

| Class | Action |
|-|-|
| tautology, stale | Delete the comment. When it named something the code does not, rename or extract instead of keeping it. |
| decision, `adr` | Write `docs/adr/NNNN-slug.md` (a paragraph: context, decision, what it costs to reverse) and delete the comment. |
| decision, `delete` | Delete the comment. |
| external, `keep` | Keep it as `external: <fact> (<proof>)`, the proof in the comment so the reviewer can check it. |
| excuse, constraint, any suppression | Not handled yet: change nothing and report it open. |

Delete only comment text, never code. Then run the repo's tests and linters again: a result that differs from step 1 means an edit touched code; undo it.

## 5. Report

Counts: deleted, kept as external, moved to ADRs, encoded as checks, issues opened, suppressions removed, open. Then each open item: `file:line`, class, and why it is open. Then the diff of what changed.
