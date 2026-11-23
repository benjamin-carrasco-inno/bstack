# Principles

One line each on when it applies. Playbooks carry the situational ones.

- **Fix root causes.** When a symptom has a cause upstream, fix it there. Guards at the call site hide the bug for the next caller.
- **Test behaviour, not implementation.** A test must fail when the behaviour breaks and pass when only the inside changes. Test at the boundary the user touches.
- **Invariants get property tests.** A promised invariant (no duplicates on re-import, no change after a failed call, sent at most once) is tested with generated inputs and injected failures (Hypothesis, proptest, fast-check).
- **Prove it works.** The claim "it works" needs output from the running thing. A check you never saw fail proves nothing; see it fail once.
- **Encode lessons in structure.** A mistake that happened twice becomes architecture, a type, a lint rule or a test, in that order of preference. Prose is the last resort, and nothing may need upkeep by hand (no hand-kept maps, inventories or copied rules).
- **Boundary discipline.** Validate and parse at the edge (request bodies, files, env, external APIs) into typed models. Inside, trust the types and do not re-check.
- **Minimise reader load.** One name per concept, the obvious place for each thing, no clever indirection. If the diff needs a paragraph to explain, the code is not done.
- **Type-system discipline.** Make illegal states unrepresentable: enums over strings, one optional where there were three, no `Any` at boundaries.
- **Checks before scale.** Strengthen the checks before adding parallel agents or unattended merges.
- **Did it actually happen?** After any action, read back the state (the row, the PR, the file). A command that returned 0 is not the result.
