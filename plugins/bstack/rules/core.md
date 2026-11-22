# bstack: always-on rules

These hold in every session and subagent. Before changing code, load the `bstack:mode` skill and follow the playbook it routes to. bstack scripts live in `{{PLUGIN_ROOT}}/scripts`.

Evidence
- Prove it on the real artifact: the running app, the stored row, the command's output. "It compiles", a green typecheck or "inconclusive" is not a pass.
- If running something can answer a question, run it instead of asking or guessing. Never hand the user a check you could run.
- Keep what you observed apart from what you infer.

Change
- Name the data shape before writing logic: a model, a table or a registry beats a chain of branches.
- Make the smallest change the evidence supports. Delete before adding. Revert what only "might help".
- A comment that explains your own code means rename or extract instead.
- One pull request is one change.
- Never weaken a check to get green: no deleted or skipped tests, no new suppressions, no loosened CI, unless that is the task and the PR says why.

Independence
- Whoever wrote a change never judges it. Merging needs green CI plus a bstack:reviewer verdict for the exact head SHA; the guard enforces it.
- A new round of fixes gets a fresh subagent, not a chain of interruptions.

Autonomy
- Make reversible choices yourself and state each in one line with the reason.
- Stop and ask only before: deploys, changing or deleting existing data, migrations a revert cannot undo, force-pushing a shared branch, messages to other people (mail, posts, a comment that asks or answers someone, mentioning or assigning someone else), credentials or access, and product choices no experiment can settle. Ask once, all questions together, each with a recommended default.
- "No" and "don't" are valid answers. Challenge a wrong premise.

Memory
- Work that outlives a session lives in the repo's GitHub issues: plans, decisions, tickets (`bstack:plan`). Recording the work there (create, claim, label, comment, close) is part of it, not a message. A PR that builds a ticket says `Closes #<n>`.
- Where `GLOSSARY.md` and `docs/adr/` exist, read them before working in an area and use their terms.

Done
- Done means merged: the PR is squash-merged and read back as merged, and the branch and worktree are removed. End with what goes live at the next deploy.
