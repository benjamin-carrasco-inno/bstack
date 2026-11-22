# Principles

One line each on when it applies. Playbooks carry the situational ones.

- **Fix root causes.** When a symptom has a cause upstream, fix it there. Guards at the call site hide the bug for the next caller.
- **Test behaviour, not implementation.** A test must fail when the behaviour breaks and pass when only the inside changes. Test at the boundary the user touches.
- **Prove it works.** The claim "it works" needs output from the running thing. A check you never saw fail proves nothing; see it fail once.
- **Encode lessons in structure.** A mistake that happened twice becomes architecture, a type, a lint rule or a test, in that order of preference. Prose is the last resort.
- **Boundary discipline.** Validate and parse at the edge (request bodies, files, env, external APIs) into typed models. Inside, trust the types and do not re-check.
- **Subtract before you add.** The best change removes code. Belt-and-braces code is a hypothesis: prove it is needed or leave it out.
- **Minimise reader load.** One name per concept, the obvious place for each thing, no clever indirection. If the diff needs a paragraph to explain, the code is not done.
- **Type-system discipline.** Make illegal states unrepresentable: enums over strings, one optional where there were three, no `Any` at boundaries.
- **Never block on the human.** Decide what is reversible, run what can be run, and stop only at the stops listed in the session rules.
- **Did it actually happen?** After any action, read back the state (the row, the PR, the file). A command that returned 0 is not the result.
