---
name: setup
description: One-time setup of bstack on a machine. Turns on auto-update for the bstack marketplace, turns off AI attribution, and checks that git, gh and node work. Use after installing bstack on a new PC, or when the user says "setup bstack".
---

# Setup

Bring `~/.claude/settings.json` (user scope) to this state, editing only these keys and keeping everything else:

```json
{
  "attribution": { "commit": "", "pr": "", "sessionUrl": false },
  "extraKnownMarketplaces": {
    "bstack": { "source": { "source": "github", "repo": "SolidDigitalDK/bstack" }, "autoUpdate": true }
  },
  "enabledPlugins": { "bstack@bstack": true }
}
```

Then check, and report each result in one line:
1. `node --version` works (the hooks run on node).
2. `gh auth status` shows a logged-in account for the repos you work in.
3. `git config --get user.email` is set for those repos.
4. Old copies of the same rules (a global CLAUDE.md or skills that repeat done-means-merged, review or merge rules) are listed for the user to trim. Do not delete them yourself.

The new settings take effect in the next session.
