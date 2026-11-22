---
name: comments
description: Clean up comments without letting the author judge them. Spawns the bstack:comment-critic agent on a scope, checks its report, then deletes tautologies and stale comments, fixes excuses and suppressions that hide bugs, encodes constraints as checks, writes ADRs, and opens issues for what is out of scope. Use for "ryd op i kommentarer", "comments", or comment findings in a review or audit.
---

# Comments

**Goal:** fewer comments. What a comment said becomes a better name, a check, an ADR or nothing. Only external facts with proof stay.

## 1. Scope

- No argument: the diff against the base branch, including the working tree (`git diff $(git merge-base origin/<base> HEAD)`) and untracked files (`git ls-files --others --exclude-standard`).
- Paths, or "the whole repo": those files.

For a diff, the comments in scope are those it adds or changes, plus existing ones in the changed files that name code the diff changes or removes (a code change can make an unchanged comment stale).

Record now: `git status --porcelain`, and the result of the repo's tests and linters.

## 2. Spawn the critic

The critic has only Read, Grep and Glob, so it cannot change the checkout; you run every command for it. Spawn `bstack:comment-critic` with only: the checkout path, the scope definition above, the absolute paths of the files in scope, and for a diff its full text. Not your view of the comments. It must form its own.

## 3. Check the report

The report is accepted only when every check holds:
- `git status --porcelain` is unchanged.
- Every line has five fields (the proof is all after the fourth ` | `) and a class with an action it allows: tautology and stale `delete`; excuse `fix` or `issue`; a suppression of any class also `fix`; decision `adr` or `delete`; constraint `encode` or `issue`; external `keep`.
- Every line has proof, and the file and line hold a comment in scope as step 1 defines it. Run every command a proof names that only reads; its output must match. One that writes, installs, changes git state or reaches a host other than localhost is not run, and its line fails.
- No comment in scope is missing: compare against a search for the comment markers in the scope's files.
- Every `keep` is external, and its proof holds when you check it again: run the command, or open the link and find the pinned version in the repo.
- Every `adr` meets all three parts of the ADR bar in `bstack:plan` (hard to reverse, surprising without context, a real trade-off). A decision that fails one is deleted.

A rejected report gets **one** rerun: a fresh critic with the same input and the failed lines, each with the check it failed. If the rerun is rejected too, the skill fails: act on nothing and report every comment in scope as open.

## 4. Act on an accepted report

| Class | Action |
|-|-|
| tautology, stale; decision `delete` | Delete the comment. |
| decision, `adr` | Write `docs/adr/NNNN-slug.md` (a paragraph: context, decision, what it costs to reverse) and delete the comment. |
| external, `keep` | Keep it as `external: <fact> (<proof>)`, the proof in the comment so the reviewer can check it. |
| excuse, `fix` | Fix the root cause with the smallest change, with no symptom guard (a retry, catch, default or special case around the symptom). Remove the hack and the comment. |
| suppression, `fix` | Fix what it hides, then remove it. A suppression with another action follows its class's row. |
| constraint, `encode` | Find the check that holds it: the existing one the proof names, else add the cheapest in scope (test, type, runtime check, lint rule). Break the constraint on purpose, run the check, see it fail, restore the code, see it pass. Then delete the comment. When no check fails, it is an `issue`. |
| excuse or constraint, `issue` | Delete the comment, leave the code, open an issue. |

Only `fix` and `encode` change code; every other edit changes only comment text. A fix that needs files outside the scope is an `issue`. Then run the repo's tests and linters again: all that passed in step 1 must pass, plus each new check. If not, undo the item that broke it and report it open.

**Issues.** One per root cause, so items with the same root cause share one. The title names the hack and its `file:line` after all your edits; the body quotes the hack's code and the deleted comment and says why it is out of scope; label `ready-for-agent` (or none, saying so, when the repo lacks it). First search open issues (`gh issue list --state open --search "<file> <key words>"`); when one names the same hack, link it instead. When `gh repo view` fails (no GitHub remote) or the user asks for a dry run, print each issue's title, label and body and open none.

## 5. Report

Counts: deleted, kept as external, moved to ADRs, encoded as checks, issues opened, suppressions removed, open. Then each encoded check with its command and the shortest line of its failing run; each issue by title with its link (or `dry run`); each suppression removed; each open item: `file:line`, class, and why it is open. Then the diff of what changed.
