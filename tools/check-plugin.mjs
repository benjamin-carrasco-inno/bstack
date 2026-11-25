#!/usr/bin/env node
// Structural checks for the plugin that `claude plugin validate` does not cover: skill and agent
// frontmatter, links and plugin-root references that resolve, size budgets that force subtraction,
// shell hooks that also cover PowerShell, and no organisation-specific content in this public repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(repo, 'plugins', 'bstack');
const errors = [];
const fail = msg => errors.push(msg);
const rel = p => path.relative(repo, p).replace(/\\/g, '/');

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.name === '.git' || e.name === 'node_modules') return [];
  return e.isDirectory() ? walk(p) : [p];
});

const BUDGET = {
  'plugins/bstack/skills/mode/SKILL.md': 8192,
  'plugins/bstack/rules/core.md': 3072,
  'plugins/bstack/rules/style.md': 2048,
};
const PLAYBOOK_BUDGET = 3584;
const SKILL_BUDGET = 6144;
const TOTAL_TEXT_BUDGET = 69866;

function frontmatter(file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return null;
  return Object.fromEntries(m[1].split(/\r?\n/).map(l => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map(x => [x[1], x[2]]));
}

// Skills and agents
for (const dir of fs.readdirSync(path.join(plugin, 'skills'))) {
  const file = path.join(plugin, 'skills', dir, 'SKILL.md');
  const fm = fs.existsSync(file) ? frontmatter(file) : null;
  if (!fm) { fail(`${rel(file)}: missing or without frontmatter`); continue; }
  if (fm.name !== dir) fail(`${rel(file)}: name "${fm.name}" must equal the directory "${dir}"`);
  if (!fm.description || fm.description.length < 40) fail(`${rel(file)}: description missing or too short to route on`);
  if (fm.description && fm.description.length > 400) fail(`${rel(file)}: description over 400 characters; it is always in context`);
}
for (const name of fs.readdirSync(path.join(plugin, 'agents'))) {
  const file = path.join(plugin, 'agents', name);
  const fm = frontmatter(file);
  if (!fm?.name || !fm?.description) fail(`${rel(file)}: needs name and description frontmatter`);
  if (fm?.name && `${fm.name}.md` !== name) fail(`${rel(file)}: name "${fm.name}" must match the file name`);
}

// Size budgets
const md = walk(plugin).filter(f => f.endsWith('.md'));
let total = 0;
for (const f of md) {
  const size = fs.statSync(f).size;
  total += size;
  const r = rel(f);
  const budget = BUDGET[r] ?? (r.includes('/playbooks/') ? PLAYBOOK_BUDGET : r.endsWith('SKILL.md') ? SKILL_BUDGET : null);
  if (budget && size > budget) fail(`${r}: ${size} bytes, budget ${budget}. Subtract before adding.`);
}
if (total > TOTAL_TEXT_BUDGET) fail(`plugin markdown totals ${total} bytes, budget ${TOTAL_TEXT_BUDGET}`);

// Links and plugin-root references
for (const f of md) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) fail(`${rel(f)}: broken link ${m[1]}`);
  }
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
    if (!fs.existsSync(path.join(plugin, m[1]))) fail(`${rel(f)}: references missing plugin file ${m[1]}`);
  }
}

// Hooks: every referenced script exists, and shell guards cover PowerShell
const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
for (const [event, groups] of Object.entries(hooks)) {
  for (const g of groups) {
    if (event === 'PreToolUse' && /\bBash\b/.test(g.matcher ?? '') && !/PowerShell/.test(g.matcher)) fail(`hooks.json: PreToolUse matcher "${g.matcher}" must also match PowerShell (Windows routes shell commands there)`);
    for (const h of g.hooks) {
      for (const a of h.args ?? []) {
        const m = /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(a);
        if (m && !fs.existsSync(path.join(plugin, m[1]))) fail(`hooks.json: ${event} references missing ${m[1]}`);
      }
      if (event === 'PreToolUse' && h.onFailure !== 'block') fail(`hooks.json: PreToolUse guard must set "onFailure": "block" so a crash does not let actions through`);
    }
  }
}

// Public repo: no organisation-specific names, addresses or hosts
const DENY = [/innovation[\s-]*living/i, /innovation-living/i, /\binno\.dk\b/i, /\baibox\b/i, /\bbeca@/i, /dashboard\.inno/i];
for (const f of walk(repo)) {
  if (rel(f) === 'tools/check-plugin.mjs' || /\.(png|jpe?g|gif|webp|ico)$/i.test(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const re of DENY) if (re.test(text)) fail(`${rel(f)}: contains organisation-specific text (${re}). Keep it in the private layer.`);
}

if (errors.length) {
  console.error(errors.map(e => `x ${e}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${md.length} markdown files, ${total} bytes of ${TOTAL_TEXT_BUDGET}`);
