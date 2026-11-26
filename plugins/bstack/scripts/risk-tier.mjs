#!/usr/bin/env node
// Derives the risk tier of a change from its unified diff, so the tier is computed, not chosen.
//   0  docs only                      -> CI
//   1  code, config, CI, instructions -> CI + reviewer verdict
//   2  data, schema, side effects, auth, concurrency, importers, weakened checks -> + interrogate
// Usage: node risk-tier.mjs [--pr <n>] [--base <ref>]   (prints JSON: { tier, reasons, exposure, flow, steps })
// The policy files come from the base: the PR's base branch through gh, or <ref> through git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyLines, readBasePolicy } from './lib/base-policy.mjs';
import { repoOfUrl } from './lib/pending.mjs';

const DOCS = /(^|\/)(LICENSE|NOTICE|CHANGELOG|README)(\.[a-z]+)?$|\.(md|rst|txt|adoc)$/i;
const BUILD_TXT = /(^|\/)(CMakeLists|requirements[^/]*)\.txt$/i;
const COMMANDS = /(^|\/)commands\//i;
const NOT_DOCS = /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)\.github\/[^/]+\.txt$|(^|\/)(skills|agents|rules)\//i;
const CONFIG = /(^|\/)(\.github\/workflows\/|\.claude\/)|(^|\/)(pyproject\.toml|setup\.cfg|ruff\.toml|\.ruff\.toml|pyrightconfig\.json|eslint\.config\.[cm]?js|\.eslintrc[^/]*|Cargo\.toml|clippy\.toml|rustfmt\.toml|package\.json|tsconfig[^/]*\.json|Dockerfile|docker-compose[^/]*\.ya?ml|\.pre-commit-config\.yaml)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$|\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE = /\.(py|pyi|js|mjs|cjs|ts|tsx|jsx|rs|go|sql|sh|ps1|html|css|vue|svelte)$/i;
export const isDocs = p => DOCS.test(p) && !NOT_DOCS.test(p) && !BUILD_TXT.test(p) && !COMMANDS.test(p);
const runnableTest = p => TEST_PATH.test(p) && CODE.test(p);
const FIXTURE = /(^|\/)(fixtures|__fixtures__|testdata)\//i;
const SCHEMA_FILE = /(^|\/)(migrations?|alembic)\/|(^|\/)schema[^/]*\.sql$|\.sql$/i;
const STYLESHEET = /\.(css|scss|sass|less)$/i;

const LITERAL_ITEM = /^\s*(["'`][^"'`]*["'`]|-?\d[\d_.]*)?\s*,?\s*$/;
export const RISK_PATHS = '.github/risk-paths.txt';
export const EXPOSURE = '.github/bstack-exposure.txt';
const POLICY_FILES = [RISK_PATHS, EXPOSURE];
const PATH_RULES = [
  [/^\.github\/(risk-paths|bstack-exposure)\.txt$/, 'risk policy file'],
  [SCHEMA_FILE, 'schema or migration file'],
  [/(^|\/)n8n\//i, 'n8n flow code (external consumer)'],
  [/(auth|login|session|permission|password|secret|crypt|oauth|token)[^/]*$/i, 'auth or secrets code', (q, f) => STYLESHEET.test(q) || (runnableTest(q) && f.removed.every(l => LITERAL_ITEM.test(l)))],
  [/(import|sync|upsert|ingest|backfill)[^/]*\.(py|rs|js|mjs|ts)$/i, 'importer or sync code'],
];

const TEMPLATE_VAR = String.raw`\{\{[^{}"'<>]*\}\}`;
const PLAIN_VALUE = String.raw`(?:[^"'{}<>\\]|${TEMPLATE_VAR})*`;
const APP_PATH = String.raw`(?:${TEMPLATE_VAR})?\/(?![/\\\s])${PLAIN_VALUE}`;
const URL_ATTR = String.raw`(?:action|formaction|hx-(?:get|post|put|patch|delete))\b`;
const FORM_ATTR = [
  String.raw`\s+(?!${URL_ATTR}|on)[a-z][\w.]*(?:-(?!on)[\w.]+)*(?:\s*=\s*(?:"${PLAIN_VALUE}"|'${PLAIN_VALUE}'|[\w.-]+))?`,
  String.raw`\s+(?!formaction)${URL_ATTR}\s*=\s*(?:"${APP_PATH}"|'${APP_PATH}')`,
  String.raw`\s*\{%[^{}<>]*%\}`,
].join('|');
const APP_FORM = new RegExp(String.raw`<form(?:${FORM_ATTR})*\s*>`, 'gi');
const APP_FETCH = /(?<![.\w$])fetch\s*\(\s*(['"`])\.?\/(?![/\\\s]|\$\{)[^'"`]{0,1000}\1\s*,\s*\{(?![^{}]{0,1000}(?:base|:\/\/))[^{}]{0,1000}\}\s*\)/g;
const withoutAppWrites = l => (/formaction/i.test(l) ? l : l.replace(APP_FORM, '')).replace(APP_FETCH, '');
const SCHEMA_STATEMENT = /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i;

const ADDED_OR_REMOVED = [
  [SCHEMA_STATEMENT, 'SQL schema statement'],
  [/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+[\w."]+\s+SET\b|\bINSERT\s+(OR\s+\w+\s+)?INTO\b|\bON\s+CONFLICT\b/i, 'SQL that writes data'],
  [/\b(os\.remove|os\.unlink|shutil\.rmtree|\.unlink\(|\.rmdir\(|fs\.(rm|rmSync|unlink|unlinkSync|rmdir)\(|remove_file|remove_dir_all)\b/, 'code that removes files'],
  [/\b(requests|httpx|session|client|reqwest|axios)\s*\.\s*(post|put|patch|delete)\s*\(|Method::(POST|PUT|PATCH|DELETE)/i, 'outbound call with side effects'],
  [/method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]/i, 'outbound call with side effects', withoutAppWrites],
  [/\b(smtplib|sendmail|send_mail|lettre|nodemailer|webhook)\b/i, 'mail or webhook'],
  [/\b(threading|multiprocessing|asyncio\.(Lock|gather|create_task)|tokio::spawn|Mutex|RwLock|BEGIN\s+(IMMEDIATE|EXCLUSIVE))\b/, 'concurrency'],
];

const WEAKENING_ADDED = [
  [/pytest\.mark\.(skip|xfail)|@unittest\.skip|#\[ignore\]|\b(it|test|describe)\.skip\(|\bx(it|describe)\(/, 'test skipped'],
  [/continue-on-error:\s*true|\|\|\s*true\b/, 'CI step allowed to fail'],
];
const PROSE_EXTENSION = /\.(md|markdown|rst|txt|adoc|asciidoc)$/i;
const isProse = p => PROSE_EXTENSION.test(p) && !BUILD_TXT.test(p) && !COMMANDS.test(p);
const CLAUDE_CODE_FRONTMATTER = /^﻿?---\s*\n([\s\S]*?)---\s*\n?/d;
const CLAUDE_CODE_EXECUTED_FENCE = /```!\s*\n?([\s\S]*?)\n?```/dg;
const INLINE_MARKER_THROUGH_ANY_PLACEHOLDER = '!(?:\\$[^\\n`]*)?`';
const LINE_WITH_INLINE_COMMAND = new RegExp(`^(.*${INLINE_MARKER_THROUGH_ANY_PLACEHOLDER}.*)$`, 'dgm');
const INLINE_COMMAND_UP_TO_NEXT_BACKTICK = new RegExp(`${INLINE_MARKER_THROUGH_ANY_PLACEHOLDER}(?=([^\`]*))`, 'dg');
const ARGUMENT_PLACEHOLDER_SPELLINGS = [/\$(?:\{[^}\n]*\}|\w*)/g, /\$(?:\{[^}\n]*\}|[^\s`$]*)/g];

function withoutPlaceholders(text, placeholder) {
  const kept = [];
  let next = 0;
  for (const m of text.matchAll(placeholder)) {
    for (let i = next; i < m.index; i++) kept.push(i);
    next = m.index + m[0].length;
  }
  for (let i = next; i < text.length; i++) kept.push(i);
  const rawStart = i => kept[i] ?? text.length;
  const rawEnd = (start, end) => (end > start ? kept[end - 1] + 1 : rawStart(start));
  return { text: kept.map(i => text[i]).join(''), toRaw: ([start, end]) => [rawStart(start), rawEnd(start, end)] };
}

function regionsIn(text) {
  const frontmatter = text.match(CLAUDE_CODE_FRONTMATTER);
  const bodyStart = frontmatter ? frontmatter[0].length : 0;
  const fences = [...text.slice(bodyStart).matchAll(CLAUDE_CODE_EXECUTED_FENCE)].map(m => m.indices[1].map(i => i + bodyStart));
  const inline = [LINE_WITH_INLINE_COMMAND, INLINE_COMMAND_UP_TO_NEXT_BACKTICK].flatMap(re => [...text.matchAll(re)].map(m => m.indices[1]));
  return [...(frontmatter ? [frontmatter.indices[1]] : []), ...fences, ...inline];
}

function executedRegions(text) {
  const substituted = ARGUMENT_PLACEHOLDER_SPELLINGS.map(placeholder => withoutPlaceholders(text, placeholder));
  return [...regionsIn(text), ...substituted.flatMap(s => regionsIn(s.text).map(s.toRaw))];
}

function executedMatch(head, line, re) {
  if (typeof head !== 'string') return true;
  const text = head.replace(/\r\n/g, '\n');
  const executed = executedRegions(text);
  let found = false;
  let start = 0;
  for (const l of text.split('\n')) {
    const end = start + l.length;
    if (l === line) {
      found = true;
      if (executed.some(([s, e]) => Math.max(s, start) < Math.min(e, end) && re.test(text.slice(Math.max(s, start), Math.min(e, end))))) return true;
    }
    start = end + 1;
  }
  return !found;
}
const SUPPRESSION = /#\s*noqa|type:\s*ignore|pyright:\s*ignore|eslint-disable|@ts-(ignore|expect-error|nocheck)|#!?\[allow\(/;
const TEST_REMOVED = /^\s*(async\s+)?def\s+test_|^\s*#\[(tokio::)?test\]|^\s*(it|test)\s*\(/;
const ASSERT = /\bassert|expect\(|assert_eq!|assert!\(/;

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
const unquote = s => {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  for (const [, oct, esc, ch] of s.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gsu)) {
    if (oct) bytes.push(parseInt(oct, 8));
    else if (esc) bytes.push(C_ESCAPES[esc] ?? esc.charCodeAt(0));
    else bytes.push(...Buffer.from(ch));
  }
  return Buffer.from(bytes).toString('utf8');
};
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const HEAD = new RegExp(`^diff --git (${QUOTED}|a/.+?) (${QUOTED}|b/.+)$`);
const SAME_HALVES = /^diff --git a\/(.+) b\/\1$/;
const RENAME = /^rename (from|to) (.+)$/;
const PATCH_SIDE = /^(---|\+\+\+) (.+?)\t?$/;

const headerPaths = line => {
  const same = SAME_HALVES.exec(line)?.[1];
  if (same) return [same, same];
  const head = HEAD.exec(line);
  return head && [unquote(head[1]).slice(2), unquote(head[2]).slice(2)];
};
const patchSidePath = s => s === '/dev/null' ? null : unquote(s).slice(2);

function realPaths({ header, rename, patch }) {
  const [from, to] = rename.some(p => p !== undefined) ? rename : patch.some(p => p !== undefined) ? patch : header;
  const path = to ?? from;
  const old = from ?? to;
  return { path, oldPath: old === path ? null : old };
}

export function parseDiff(diff) {
  const files = [];
  let f = null;
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    const header = headerPaths(line);
    if (header) {
      f = { header, rename: [undefined, undefined], patch: [undefined, undefined], inHunk: false, added: [], removed: [], created: false, deleted: false };
      files.push(f); continue;
    }
    if (!f) continue;
    const rename = RENAME.exec(line);
    const side = !f.inHunk && PATCH_SIDE.exec(line);
    const at = side && (side[1] === '---' ? 0 : 1);
    if (rename) f.rename[rename[1] === 'from' ? 0 : 1] = unquote(rename[2]);
    else if (side && f.patch[at] === undefined) f.patch[at] = patchSidePath(side[2]);
    else if (line.startsWith('@@')) f.inHunk = true;
    else if (line.startsWith('new file mode')) f.created = true;
    else if (line.startsWith('deleted file mode')) f.deleted = true;
    else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) f.added.push(line.slice(1));
    else if (line.startsWith('-')) f.removed.push(line.slice(1));
  }
  return files.map(({ header, rename, patch, inHunk, ...rest }) => ({ ...realPaths({ header, rename, patch }), ...rest }));
}

function globToRegex(glob) {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

const riskPathsMatcher = globs => {
  const res = globs.map(globToRegex);
  return p => res.some(re => re.test(p));
};

export const tierZeroDocs = extraPaths => {
  const listed = riskPathsMatcher(extraPaths);
  return p => isDocs(p) && !listed(p);
};

export const exposureOf = text => (policyLines(text).join('\n') === 'internal' ? 'internal' : 'external');

const OWNER_OK = 'the owner comments bstack-user-ok sha=<head>';
const STEPS = {
  0: ['CI green'],
  1: ['CI green', 'reviewer verdict for the head'],
  external: ['CI green', 'reviewer verdict for the head', 'interrogate for the head without blocking findings (after 3 blocking rounds: the owner OK)'],
  internal: ['CI green', 'reviewer verdict for the head', 'interrogate for a commit of this PR; blocking findings only on an earlier commit, judged before the verdict'],
};

// A policy file change or a path in risk-paths.txt keeps the external flow.
export function gatePlan(diff, tier, { extraPaths = [], exposure = 'external' } = {}) {
  const paths = parseDiff(diff).flatMap(f => [f.path, f.oldPath]).filter(Boolean).map(p => p.replace(/\\/g, '/'));
  const policyChange = tier === 2 && paths.some(p => POLICY_FILES.includes(p));
  const listed = riskPathsMatcher(extraPaths);
  const flow = tier === 2 && exposure === 'internal' && !policyChange && !paths.some(listed) ? 'internal' : 'external';
  const steps = tier === 2 ? [...STEPS[flow], ...(policyChange ? [OWNER_OK] : [])] : STEPS[tier];
  return { exposure, flow, policyChange, steps };
}

const readOrNull =(readFile, p) => { try { return readFile?.(p) ?? null; } catch { return null; } };

export function riskTier(diff, { extraPaths = [], readFile } = {}) {
  const files = parseDiff(diff);
  const reasons = new Set();
  let tier = 0;
  const raise = (t, why) => { if (t > tier) tier = t; if (t >= 1 && why) reasons.add(why); };
  const extra = riskPathsMatcher(extraPaths);

  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    if (!isDocs(p)) raise(1, CONFIG.test(p) ? `config or CI: ${p}` : null);
    if (extra(p)) raise(2, `listed in .github/risk-paths.txt: ${p}`);
    const paths = f.oldPath ? [p, f.oldPath.replace(/\\/g, '/')] : [p];
    const fixture = paths.every(q => FIXTURE.test(q));
    const isTest = TEST_PATH.test(p);
    const testOnly = paths.every(q => TEST_PATH.test(q));
    const sqlLines = [...f.added, ...f.removed];
    const testFixtureSql = testOnly && fixture && paths.every(q => /\.sql$/i.test(q)) && sqlLines.length > 0;
    if (testFixtureSql && sqlLines.some(l => SCHEMA_STATEMENT.test(l))) raise(2, `SQL schema statement: ${p}`);
    for (const q of paths) for (const [re, why, exempt] of PATH_RULES) if (re.test(q) && !exempt?.(q, f) && !(testFixtureSql && re === SCHEMA_FILE)) raise(2, `${why}: ${q}`);

    if (isTest && f.deleted) raise(2, `test file deleted: ${p}`);
    if (f.oldPath && runnableTest(paths[1]) && !runnableTest(p)) raise(2, `test file renamed out of the suite: ${paths[1]} -> ${p}`);
    if (isTest && f.removed.some(l => TEST_REMOVED.test(l))) raise(2, `test removed: ${p}`);
    if (isTest) {
      const lost = f.removed.filter(l => ASSERT.test(l)).length - f.added.filter(l => ASSERT.test(l)).length;
      if (lost > 0) raise(2, `fewer assertions: ${p}`);
    }
    const prose = isProse(p);
    let head;
    const executes = (l, re) => !prose || executedMatch(head === undefined ? (head = readOrNull(readFile, p)) : head, l, re);
    for (const l of f.added) for (const [re, why] of WEAKENING_ADDED) if (re.test(l) && executes(l, re)) raise(2, `${why}: ${p}`);
    if (!PROSE_EXTENSION.test(p) && !fixture && !testOnly && f.added.some(l => SUPPRESSION.test(l))) raise(2, `new lint or type suppression: ${p}`);
    if (/(^|\/)\.github\/workflows\//.test(p) && f.removed.some(l => /^\s*(-\s+)?(run|uses):/.test(l))) raise(2, `CI step removed or changed: ${p}`);

    if (CODE.test(p) && !isTest) {
      for (const l of [...f.added, ...f.removed]) {
        if (/^\s*(#|\/\/|\*)/.test(l) || /^\s*@/.test(l)) continue; // comments and decorators
        for (const [re, why, appOnly] of ADDED_OR_REMOVED) if (re.test(l) && (!appOnly || re.test(appOnly(l)))) raise(2, `${why}: ${p}`);
      }
    }
  }
  if (!files.length) reasons.add('empty diff');
  return { tier, reasons: [...reasons].slice(0, 12) };
}

export const ghFileReader = (gh, repo, sha) => p =>
  gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`]);

function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  let diff;
  let policy;
  let exposure = '';
  let readFile = p => fs.readFileSync(path.join(run('git', ['rev-parse', '--show-toplevel']).trim(), p), 'utf8');
  if (opt('--pr')) {
    diff = run('gh', ['pr', 'diff', opt('--pr')]);
    const pr = JSON.parse(run('gh', ['pr', 'view', opt('--pr'), '--json', 'url,headRefOid,baseRefName']));
    readFile = ghFileReader(a => run('gh', a), repoOfUrl(pr.url), pr.headRefOid);
    policy = readBasePolicy(a => run('gh', a), repoOfUrl(pr.url), pr.baseRefName, RISK_PATHS);
    try { exposure = readBasePolicy(a => run('gh', a), repoOfUrl(pr.url), pr.baseRefName, EXPOSURE); } catch { exposure = ''; }
  } else {
    let base = opt('--base');
    if (!base) {
      try { base = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim(); } catch { base = 'origin/main'; }
    }
    diff = run('git', ['diff', '--no-color', `${base}...HEAD`]) + run('git', ['diff', '--no-color', 'HEAD']);
    const atBase = file => (run('git', ['ls-tree', '--name-only', base, file]).trim() ? run('git', ['show', `${base}:${file}`]) : '');
    policy = atBase(RISK_PATHS);
    exposure = atBase(EXPOSURE);
  }
  const extraPaths = policyLines(policy);
  const risk = riskTier(diff, { extraPaths, readFile });
  const plan = gatePlan(diff, risk.tier, { extraPaths, exposure: exposureOf(exposure) });
  console.log(JSON.stringify({ ...risk, exposure: plan.exposure, flow: plan.flow, steps: plan.steps }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
