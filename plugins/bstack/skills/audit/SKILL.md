---
name: audit
description: Review and clean up a whole repository. Finds real bugs, data and security risks, broken contracts, missing checks and slop, proves each finding, and lands the fixes as small gated PRs. Use for "review this repo", "find fejl", "ryd op", "gennemgå repoet", or before building on code you did not write.
---

# Audit

**Goal:** the repo ends up correct, smaller and guarded by checks that stop the same problems coming back, reached through small PRs that each prove one thing. The report is a means, not the product.

Run one audit per repo, in its own session and worktree.

## 1. Map (read-only)

- What the app is for, its entry points, and how it runs (README, launch config, Dockerfile, CI).
- Where data lives and who else reads or writes it: other apps, n8n or other automation, shared files, exports, webhooks. Read the consumer side's code or flow definitions where you can reach them.
- **Baseline**: run what exists (tests, linters, typecheck, the app per `bstack:verify`) and record what passes, fails and cannot run. Then run the strict versions the repo does not yet enforce (full linter rule set, typechecker, the stack's audit tool), to see the size of the gap.
- **Standards layer**: if a skill or template defines this project's standards (CI, lint config, launch config, contracts), compare the repo against it. Deviations are findings, not decisions.

## 2. Find

Look in this order. It is the order of damage.
1. **Data correctness**: writes, deletes, counts, imports, upserts, idempotency, partial failures, time zones, encodings, rounding.
2. **Security at the boundary**: auth on every route, input validation, path traversal, injection (SQL built from strings, shell, templates), secrets in the repo or logs, SSRF, unsafe file writes.
3. **Failure handling**: swallowed exceptions, retries without limits, silent fallbacks, missing timeouts on outbound calls.
4. **External contracts**: payloads and files others read; renames that would break them; missing contract tests.
5. **Missing checks**: what CI does not run, and risky paths without tests.
6. **Slop**: dead code, duplicated logic, defensive branches for impossible states, options nobody uses, files nothing imports. Comments and suppressions: `bstack:comments`.

For a large repo, split the reading across parallel read-only Explore subagents, one per area, each returning findings with `file:line`.

## 3. Prove

A finding counts only with evidence: a failing test, a request against the running app, a command's output, or for slop, proof of non-use (search, import graph, coverage). Anything without evidence is listed as a hypothesis or dropped. Never run a path with real side effects to prove a point (see `bstack:verify`).

Rank by severity (data loss or security, then wrong results, then maintenance cost) and by confidence.

## 4. Present once

One message: the findings ranked, each with its evidence, its risk tier, and the PR it belongs to. Ask only what needs the user (product choices, anything a revert cannot undo) and proceed with everything else by default.

## 5. Fix

- **Checks first.** The first PR turns on the missing checks (strict lint, typecheck, tests in CI, contract tests), with workflows written per [CI](../mode/ci.md). Fix the existing violations or baseline them per file with a stated reason. No blanket ignores.
- **Then one PR per finding** or per class of identical findings, each through its playbook: bug-fix for bugs (the evidence from step 3 becomes the failing test), refactor for slop (lock the behaviour first), migration for anything that touches stored data or contracts.
- Independent PRs can run in parallel worktrees. Keep at most three open per repo, to limit merge-ins.
- Every PR goes through ship, gates included. No exceptions for "small" cleanups.

## 6. Close

- A finding class that showed up twice or more goes to `bstack:correct`, so a check prevents it from now on.
- Final report: merged PRs, findings left open with the reason for each, and what goes live at the next deploy.
