# Bug fix

1. **Reproduce it yourself** on the surface the user hit (the `bstack:verify` skill: running app, HTTP, browser for UI). Record the steps and the output. If you cannot reproduce it, stop and report what you tried. Do not fix a guess.
2. **Narrow the cause with evidence**: logs, a temporary print, a minimal input, `git bisect run <test>`. State the root cause in one sentence: what is wrong, where, and since which commit if known.
3. **Failing test first**, in its own commit: it fails on the current code for the intended reason (quote the failure line). Test the behaviour at the boundary the user touched, not internals. No test at all beats a test that cannot fail.
   - The only exemption: pure styling or layout with no logic. A before/after screenshot replaces the test.
4. **Fix the cause** at the most durable level that holds (data shape, type, validation at the boundary), not the symptom at one call site. Remove any temporary instrumentation.
5. **Confirm on the same surface** as step 1: same steps, new output.
6. **Same class elsewhere?** Search for the pattern. Identical cases go in this PR; others go to the final report for `bstack:correct`.
7. **Ship** ([ship](ship.md)). The PR names the PR that introduced the bug when known ("fixes regression from #12"), so merge-quality can count it.

**Gate to ship:** the reproduction output, the test failing before and passing after, and the confirmation output.
