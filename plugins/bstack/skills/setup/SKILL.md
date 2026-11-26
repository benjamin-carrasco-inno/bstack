---
name: setup
description: Set up bstack on a machine: auto-update on, AI attribution off, git, gh and node checked, installs brought to main. Use after installing, or for "setup bstack".
---

# Setup

In every Claude config dir (`~/.claude`, and each `~/.claude*` used through `CLAUDE_CONFIG_DIR`), bring `settings.json` to this state, changing only these keys:

```json
{
  "attribution": { "commit": "", "pr": "", "sessionUrl": false },
  "extraKnownMarketplaces": {
    "bstack": { "source": { "source": "github", "repo": "benjamin-carrasco-inno/bstack" }, "autoUpdate": true }
  },
  "enabledPlugins": { "bstack@bstack": true }
}
```

Then check, one line each:
1. `node --version` works (hooks need it).
2. `gh auth status` is logged in for your repos.
3. `git config --get user.email` is set.
4. List old copies of bstack's rules (a global CLAUDE.md, other skills) for the user to trim; never delete them.
5. `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-status.mjs" <each config dir>` compares each install with main. Behind: run the update it prints, with the owner's OK.

Changes take effect in the next session.
