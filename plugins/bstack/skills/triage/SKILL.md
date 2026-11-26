---
name: triage
description: Sort incoming GitHub issues (bug reports and requests) into work an agent can take. Checks the claim, finds duplicates and work already done, and writes the acceptance criteria. Use for "triage", "hvad ligger der", "gennemgå issues", "hvad er klar", or an issue without acceptance criteria.
---

# Triage

**Goal:** every open issue is either ready to build with criteria a reviewer can check, waiting on someone named, or closed with a reason.

## States

Each triaged issue carries one category and one state label. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" labels` once per repo before the first label write.
- Category: `bug` (something is broken) or `enhancement` (new or better behaviour).
- State: `needs-triage` (not yet judged), `needs-info` (waiting on the reporter), `ready-for-agent`, `ready-for-human` (needs judgement, access or manual testing; say which), `wontfix` (closed with the reason).

Issues labelled `plan:*` belong to a map or spec (`bstack:plan`) and are not triaged.

## What needs attention

`gh issue list --state open --json number,title,labels,author,createdAt,updatedAt --limit 200`, then group oldest first: no labels, `needs-triage`, and `needs-info` where the reporter has replied since the last triage comment. One line each, with counts. Then work through them, or the one the user names.

## Triage one issue

1. **Read all of it**: body, comments, labels, earlier triage notes (do not re-ask what is answered).
2. **Already there?** Search the code by concept, not only by the issue's words, and search open and closed issues. Already built: a closing comment with where it lives (`gh issue close <n> --reason completed`). A duplicate: `gh issue close <n> --duplicate-of <original>`. Both close someone's request, so see Talking to people.
3. **Check the claim.** A bug is reproduced on the surface the reporter used (`bstack:verify`, test data only). Record what happened: confirmed with the code path, not reproduced, or too little detail. A confirmed reproduction makes the best ticket.
4. **Grill if needed.** When the request is unclear and the user owns the decision, grill them (`bstack:plan`). Bigger than one PR: it becomes a spec or a map. Remove this issue's state label, comment the link, and list it under the spec's Sources; it closes with the spec.
5. **Write the outcome** as one comment and set the labels:
   - `ready-for-agent`: the ticket shape from `bstack:plan` ([tickets](../plan/tickets.md)): current and wanted behaviour, acceptance criteria a reviewer can check, `Expected tier`, out of scope. Describe behaviour and contracts, not files or lines.
   - `ready-for-human`: the same, plus why an agent cannot do it.
   - `needs-info`: what is established, and specific questions for the reporter.
   - `wontfix`: the reason, then close.

## Talking to people

Anything that asks a reporter something or closes their request for another reason (duplicate, already built, wontfix) is a message to a person: draft them all, show them to the user once, and post only after the OK. The user's own issues and issues an agent created need no OK. Never mention or assign someone else without the OK.

## Done

Report: counts per state before and after, what is now `ready-for-agent` (by title with the link), and the drafted messages waiting for the OK.
