# Refactor

Same behaviour, better shape. If behaviour changes, it is a feature or a bug fix.

**UI harmonisation** (moving existing UI to tokens, components and container queries per `bstack:frontend`) keeps function unchanged: routes, data, actions. The look may change, so identical pixels are not the lock. The lock is before and after screenshots at 375 and 1280 px in the PR, plus a clean browser check (`bstack:verify`) on each changed page.

1. **Lock the behaviour first.** A characterisation test or snapshot of the outputs that matter (HTTP responses, rows written, files produced), run green on the current code. A typecheck is not a lock.
2. **Delete before you add.** Dead code, unused parameters, duplicate helpers and unreachable branches go first, each proven unused (search, import graph, coverage).
3. **Move every caller, then delete the old API in the same change.** No shims, no aliases, no "deprecated" wrappers left behind.
4. **Check renames outside the type system**: strings, SQL, JSON keys, templates, environment names, and files other systems read (n8n flows, exports, payload field names). A renamed payload field is a migration, not a refactor.
5. **Prove equivalence**: the lock from step 1 passes unchanged; for data paths, compare old and new output on the same fixture.
6. **Readability check.** If the code is not easier to read than before, revert. A refactor that only moves complexity is not worth a review.
7. **Ship** ([ship](ship.md)).

**Gate to ship:** the lock was green before and is green after, with no edits to the lock itself.
