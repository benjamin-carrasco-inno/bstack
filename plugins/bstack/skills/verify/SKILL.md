---
name: verify
description: Run the app and prove behaviour on the real surface. Start it safely on test data, exercise the changed route over HTTP or in a browser, and check side effects where they land. Used by bug-fix, feature, refactor, audit and the reviewer.
---

# Verify

**Goal:** evidence from the running thing, not from reading code.

## Start safely

- Use the repo's launch configuration (`.claude/launch.json`) or its documented dev command on test fixtures, in a worktree, via `run_in_background`, on its own absolute temp path (`DATA_DIR=/tmp/review`). Never production data, production URLs or real accounts.
- **Side effects first.** Before running any path that could publish, send mail, call webhooks or paid APIs, or write to shared storage, confirm the app is in a dry-run, simulator or test mode and that outbound targets are empty or local mocks. If the mode lives in a database or a settings page, check it there, not in the code. A "test" mode that still talks to the real platform is not safe. If you cannot confirm it, do not run that path; report the gap.
- No launch configuration: derive the start command from the README or Dockerfile and list "add a launch config on fixtures" as a finding.

## Find the surface

- HTTP apps: list the routes from the framework, for example FastAPI's `/openapi.json`, or the router definitions in source (axum `Router::route`, Express `app.get`).
- UI: browser automation when available. Otherwise fetch the page and call the API requests it makes.
- CLI and jobs: run them with fixture input.
- MCP endpoints: list the tools and call the read-only ones.

## Prove

1. State the expected result before running.
2. Exercise the user path the change touches, with realistic input and one hostile input (empty, huge, wrong type, another user's id).
3. Check side effects where they land: rows in SQLite (`sqlite3 <db> "select ..."`), written files, calls captured by the mock.
4. Compare with the expectation. Record the command and the decisive output lines. Long output goes in a PR comment, not the body.
5. Stop the app and remove temporary data.

## UI changes

When the diff touches HTML, CSS, templates or client JS, run [browser-check.js](browser-check.js) on each changed page in browser automation: on a same-origin page of the running app, evaluate the file's text followed by `({ paths: ['/changed', '/other'] })`; `widths` overrides 375, 768 and 1280. Without browser tools: `node "${CLAUDE_PLUGIN_ROOT}/skills/verify/browser-check-run.mjs" <origin> /changed /other` (Node 22, local Chrome or Edge). It returns JSON:
- `findings`: overflow per width, duplicate ids, inputs without a label, `href="#"`, leftover template placeholders. One the change introduced is a FAIL.
- `breakpoints`: each grid or flex-wrap switch from 320 to 1600 px with its narrowest column in ch. A report, not a gate.

## Verdict language

- **PASS**: the path works on the real surface and the evidence is attached.
- **PASS+NOTES**: it works; the notes are concrete and non-blocking.
- **FAIL**: it does not work, or could not be shown to work. Inconclusive is FAIL. A lane that could not run is a gap, never a pass.
