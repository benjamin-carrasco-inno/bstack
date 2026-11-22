# Ticket

Building one issue. The ticket is the contract: its acceptance criteria are the gate, and the reviewer judges against them.

1. **Load**: `gh issue view <n> --json number,title,body,labels,assignees,parent,blockedBy,comments`. Without a number ("next", "tag den næste"), take `next` from `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" next [<spec>]`. Read the parent spec; open its sources only where a decision is unclear.
2. **Check it can start**:
   - An open blocker or someone else's claim: take the next one instead.
   - A `plan:*` label: it is a decision, not a build. Use `bstack:plan`.
   - `ready-for-human`: needs the user. Say what for, and take the next one.
   - No acceptance criteria you could check: run `bstack:triage` on it first.
3. **Claim** it: `gh issue edit <n> --add-assignee @me`, before any other work.
4. **Build** through the playbook its content calls for (bug-fix, feature, refactor, migration). Each acceptance criterion is proven on the real surface, not just in a unit test.
5. **Stay in the ticket.** Something else you find becomes a new issue (`needs-triage`, what you saw and where), not part of the diff.
6. **Ship** ([ship](ship.md)) with the ticket as the request: the PR's Request section links the ticket and quotes its acceptance criteria, and the body has a line `Closes #<n>`.
7. **After the merge**, read the ticket back as closed. If it was the last open sub-issue of its spec, close the spec with a comment of what landed. Report the next ticket from `tracker.mjs next <spec>`.

**Gate to ship:** proof for every acceptance criterion, plus the gates of the build playbook.

**Stopping mid-way:** push the branch and leave one status comment (on the PR if there is one, else on the ticket): how far, the next step, open questions. Keep the claim if you will return, remove it if not (`--remove-assignee @me`).
