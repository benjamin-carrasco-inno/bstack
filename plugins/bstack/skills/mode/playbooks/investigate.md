# Investigate

Read-only. No branch, no PR.

1. **Make the question checkable.** Restate it as something an observation can settle ("does the importer drop rows when a page fails?").
2. **Trace the path.** From the entry point (route, CLI, scheduled job, webhook) to where the data lands. Cite `file:line` for each hop.
3. **Answer "why" from history**, not from guessing intent: `git log -S '<symbol>'`, `git blame -L`, and the PR that introduced it (`gh pr list --state merged --search <sha>`), including its review thread.
4. **Run it when running settles it**: a request against the app started per the `bstack:verify` skill, a query on fixture data, a script with a crafted input.
5. **Answer**: conclusion first, then the evidence with sources, then what is inference and the one observation that would confirm it.

**Gate:** every claim has a source (`file:line`, command output, commit, PR) or is labelled as inference.

If the answer reveals a bug or a risk, say so and offer the matching playbook. Do not start fixing inside an investigation.
