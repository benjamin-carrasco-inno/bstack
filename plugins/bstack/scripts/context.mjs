#!/usr/bin/env node
// SessionStart and SubagentStart hook: injects the always-on rules (and, for the main session, the
// answer style) so they hold without anyone remembering to load a skill. One source: rules/*.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'subagent' ? 'subagent' : 'session';
const read = name => fs.readFileSync(path.join(root, 'rules', name), 'utf8').trim();

let text = read('core.md').replaceAll('{{PLUGIN_ROOT}}', root.replace(/\\/g, '/'));
if (mode === 'session') text += `\n\n${read('style.md')}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: mode === 'session' ? 'SessionStart' : 'SubagentStart',
    additionalContext: text,
  },
}));
