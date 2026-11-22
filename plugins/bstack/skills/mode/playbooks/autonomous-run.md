# Autonomous run

For "keep going until X", background sessions and runs nobody watches.

1. **Write the stop condition as a checkable predicate**, not a duration: "all tests green and `ruff check` reports 0 errors", "every finding in the audit list has a merged PR or a stated reason", "every ticket under the spec is closed, or handed to the user as `ready-for-human`". State it in the first reply.
2. **One change and one check per round.** Measure before and after. A change that did not move the predicate is reverted, not kept "just in case".
3. **On a plateau, change approach**: a different hypothesis, a smaller step, a fresh subagent. Never relax the predicate to reach it.
4. **Side findings go in their own PR**, never folded into the current one.
5. **Working a queue of tickets**: one at a time through [ticket](ticket.md). Tickets that need the user (`ready-for-human`, `plan:grill`, `plan:prototype`) are collected for them, not done.
6. **Stops still apply**: anything on the stop list in the session rules waits for the user. Collect those questions and keep working on everything else.
7. **Leave a trail without a log file.** When quota runs out or the session is stopped, post a short status as a comment on the PR, or on the ticket when there is no PR yet (how far, the branch, the next step, open questions), then remove your claim on the ticket, so a new session can pick up from GitHub alone.
8. Every change lands through [ship](ship.md), gates included. A run is done when the predicate holds on main.
