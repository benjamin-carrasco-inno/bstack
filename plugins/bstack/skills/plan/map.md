# Map

For work where the destination is known but the way is not. The map finds the way; it does not walk it. Each ticket settles a decision, and the map is done when nothing is left to decide before someone builds.

## The map issue

One issue labelled `plan:map`. It is an index, not a store: each decision lives in its ticket, and the map gives a one-line gist and a link. Open tickets are not listed in it; they are its open sub-issues.

```markdown
## Destination
What reaching the end looks like: usually a spec that can be built, sometimes one locked decision or a change made in place. One or two lines.

## Notes
Domain, constraints, skills every session should use, standing preferences.

## Decisions so far
- <closed ticket title, linked>: one-line gist of the answer

## Not yet specified
Fog: questions you can see coming but cannot yet phrase sharply. In scope.

## Out of scope
- <closed ticket title, linked>: gist, and why it is beyond the destination
```

## Decision tickets

Sub-issues of the map, each a question sized to one session, body `## Question`. One type label each:
- `plan:research` (agent alone): a fact a decision waits on, from primary sources (docs, APIs, the code). Run in a fresh subagent; the answer comment cites its sources.
- `plan:prototype` (with the user): a cheap, rough artifact to react to (a page, a stub, a sample output) when "how should it look or behave" is the question. Build it with `bstack:vibecoding`, never merged, deleted when the ticket closes; the decision is what survives.
- `plan:grill` (with the user): a conversation. The default type.
- `plan:task` (agent alone where it can, otherwise a precise checklist for the user): work that must happen before a decision can be made, such as getting access or looking at real data. The answer records what was done and the facts later tickets need (where a credential lives, not the credential).

A ticket with the user is only resolved by the user. An agent that answers its own grilling question has broken it.

**Fog or ticket?** Ticket when you can state the question sharply now, even if it is blocked. Fog when you cannot yet. Do not pre-slice fog into tickets.

## Chart (one session)

1. Grill the user until the destination is settled. It fixes the scope.
2. Grill again, breadth first: the open decisions across the whole space and the first ones takeable now. If no fog turns up, the work does not need a map; say so and go to [tickets](tickets.md).
3. Run `tracker.mjs labels`, create the map, then the tickets you can state now as sub-issues, then wire blocking in a second pass.
4. Start the research tickets in parallel subagents. Resolve nothing else in this session.

## Work the map (one ticket per session)

1. Read the map, not every ticket. Take the ticket the user named, or the first from `tracker.mjs next <map>`. Claim it.
2. Resolve it as its label says. Read related closed tickets on demand.
3. Record: the answer as a comment, close the ticket, add the gist line to Decisions so far.
4. Move the frontier: new tickets for fog that is now sharp (and remove it from Not yet specified), close tickets the answer made moot or out of scope, fix tickets the answer changed.

Research tickets may run several per session; every other type is one per session, so each decision gets a full context. Other sessions may be working the same map; re-read before you write.

## Finish

When every sub-issue is closed (`progress` from `tracker.mjs next <map>` has completed equal to total) and Not yet specified is empty, the way is clear. An empty `next` alone is not enough: the rest may be blocked or claimed. Write the destination: usually a spec from the map ([tickets](tickets.md)), linked from the map and linking back to the decision tickets, so a builder can read the source of any decision. Then close the map.
