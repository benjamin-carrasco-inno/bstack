# Feature

1. **Trace the subsystem** the feature lives in: entry points, data model, who reads its output (other apps, n8n, files, exports). Note what must not change.
2. **Model the domain first.** Name the data shape: the model, table or enum, the states and who owns each piece of state. Write it before any logic.
3. **Sketch two shapes**, as types and signatures, not prose: for example extend the existing model or add a table; one endpoint or two. Pick the one where every piece of state has one owner and the diff is smaller. One line on why.
4. **Build in small verifiable steps.** After each step something runs: a test, a request, a page. Commit when a step is proven.
5. **Tests** for the behaviour the user will rely on, at the boundary (HTTP route, CLI, page), including one hostile input (empty, too large, wrong type, someone else's id).
6. **Prove it on the running app** per `bstack:verify`, on fixture data, including side effects (rows written, files created, calls made to mocks).
7. **Ship** ([ship](ship.md)).

**Gate to ship:** proof on the running app plus tests that fail without the feature.
