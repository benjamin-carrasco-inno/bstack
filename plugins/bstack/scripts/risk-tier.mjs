#!/usr/bin/env node
// Derives the risk tier of a change from its unified diff, so the tier is computed, not chosen.
//   0  docs only                      -> CI
//   1  code, config, CI, instructions -> CI + reviewer verdict
//   2  data, schema, side effects, auth, concurrency, importers, weakened checks -> + interrogate
// Usage: node risk-tier.mjs [--pr <n>] [--base <ref>]   (prints JSON: { tier, reasons })
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoOfUrl } from './lib/pending.mjs';

const DOCS = /(^|\/)(LICENSE|NOTICE|CHANGELOG|README)(\.[a-z]+)?$|\.(md|rst|txt|adoc)$/i;
const BUILD_TXT = /(^|\/)(CMakeLists|requirements[^/]*)\.txt$/i;
const COMMANDS = /(^|\/)commands\//i;
const NOT_DOCS = /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)\.github\/[^/]+\.txt$|(^|\/)(skills|agents|rules)\//i;
const CONFIG = /(^|\/)(\.github\/workflows\/|\.claude\/)|(^|\/)(pyproject\.toml|setup\.cfg|ruff\.toml|\.ruff\.toml|pyrightconfig\.json|eslint\.config\.[cm]?js|\.eslintrc[^/]*|Cargo\.toml|clippy\.toml|rustfmt\.toml|package\.json|tsconfig[^/]*\.json|Dockerfile|docker-compose[^/]*\.ya?ml|\.pre-commit-config\.yaml)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)$|\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE = /\.(py|pyi|js|mjs|cjs|ts|tsx|jsx|rs|go|sql|sh|ps1|html|css|vue|svelte)$/i;
const runnableTest = p => TEST_PATH.test(p) && CODE.test(p);
const FIXTURE = /(^|\/)(fixtures|__fixtures__|testdata)\//i;
const SCHEMA_FILE = /(^|\/)(migrations?|alembic)\/|(^|\/)schema[^/]*\.sql$|\.sql$/i;

const PATH_RULES = [
  [SCHEMA_FILE, 'schema or migration file'],
  [/(^|\/)n8n\//i, 'n8n flow code (external consumer)'],
  [/(auth|login|session|permission|password|secret|crypt|oauth|token)[^/]*$/i, 'auth or secrets code'],
  [/(import|sync|upsert|ingest|backfill)[^/]*\.(py|rs|js|mjs|ts)$/i, 'importer or sync code'],
];

const SCHEMA_STATEMENT = /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i;

const ADDED_OR_REMOVED = [
  [SCHEMA_STATEMENT, 'SQL schema statement'],
  [/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+[\w."]+\s+SET\b|\bINSERT\s+(OR\s+\w+\s+)?INTO\b|\bON\s+CONFLICT\b/i, 'SQL that writes data'],
  [/\b(os\.remove|os\.unlink|shutil\.rmtree|\.unlink\(|\.rmdir\(|fs\.(rm|rmSync|unlink|unlinkSync|rmdir)\(|remove_file|remove_dir_all)\b/, 'deletes files'],
  [/\b(requests|httpx|session|client|reqwest|axios)\s*\.\s*(post|put|patch|delete)\s*\(|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|Method::(POST|PUT|PATCH|DELETE)/i, 'outbound call with side effects'],
  [/\b(smtplib|sendmail|send_mail|lettre|nodemailer|webhook)\b/i, 'mail or webhook'],
  [/\b(threading|multiprocessing|asyncio\.(Lock|gather|create_task)|tokio::spawn|Mutex|RwLock|BEGIN\s+(IMMEDIATE|EXCLUSIVE))\b/, 'concurrency'],
];

const WEAKENING_ADDED = [
  [/pytest\.mark\.(skip|xfail)|@unittest\.skip|#\[ignore\]|\b(it|test|describe)\.skip\(|\bx(it|describe)\(/, 'test skipped'],
  [/continue-on-error:\s*true|\|\|\s*true\b/, 'CI step allowed to fail'],
];
const PROSE_EXTENSION = /\.(md|markdown|rst|txt|adoc|asciidoc)$/i;
const isProse = p => PROSE_EXTENSION.test(p) && !BUILD_TXT.test(p) && !COMMANDS.test(p);
const CLAUDE_CODE_EXECUTED_MARKDOWN = [/```!\s*\n?([\s\S]*?)\n?```/dg, /(?<=^|\s)!`([^`]+)`/dgm, /^﻿?---\n([\s\S]*?)\n---(?=\n|$)/dg];

function executedMatch(head, line, re) {
  if (typeof head !== 'string') return true;
  const text = head.replace(/\r\n/g, '\n');
  const executed = CLAUDE_CODE_EXECUTED_MARKDOWN.flatMap(x => [...text.matchAll(x)].map(m => m.indices[1]));
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

export function parseDiff(diff) {
  const files = [];
  let f = null;
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    const head = HEAD.exec(line);
    if (head) {
      const [a, b] = [unquote(head[1]).slice(2), unquote(head[2]).slice(2)];
      f = { path: b, oldPath: a === b ? null : a, added: [], removed: [], created: false, deleted: false };
      files.push(f); continue;
    }
    if (!f) continue;
    const from = /^rename from (.+)$/.exec(line)?.[1];
    if (from) f.oldPath = unquote(from) === f.path ? null : unquote(from);
    else if (line.startsWith('new file mode')) f.created = true;
    else if (line.startsWith('deleted file mode')) f.deleted = true;
    else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) f.added.push(line.slice(1));
    else if (line.startsWith('-')) f.removed.push(line.slice(1));
  }
  return files;
}

function globToRegex(glob) {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

const readOrNull = (readFile, p) => { try { return readFile?.(p) ?? null; } catch { return null; } };

export function riskTier(diff, { extraPaths = [], readFile } = {}) {
  const files = parseDiff(diff);
  const reasons = new Set();
  let tier = 0;
  const raise = (t, why) => { if (t > tier) tier = t; if (t >= 1 && why) reasons.add(why); };
  const extra = extraPaths.map(globToRegex);

  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    const docs = DOCS.test(p) && !NOT_DOCS.test(p) && !BUILD_TXT.test(p) && !COMMANDS.test(p);
    if (!docs) raise(1, CONFIG.test(p) ? `config or CI: ${p}` : null);
    if (extra.some(re => re.test(p))) raise(2, `listed in .github/risk-paths.txt: ${p}`);
    const paths = f.oldPath ? [p, f.oldPath.replace(/\\/g, '/')] : [p];
    const fixture = paths.every(q => FIXTURE.test(q));
    const isTest = TEST_PATH.test(p);
    const testOnly = paths.every(q => TEST_PATH.test(q));
    const sqlLines = [...f.added, ...f.removed];
    const testFixtureSql = testOnly && fixture && paths.every(q => /\.sql$/i.test(q)) && sqlLines.length > 0;
    if (testFixtureSql && sqlLines.some(l => SCHEMA_STATEMENT.test(l))) raise(2, `SQL schema statement: ${p}`);
    for (const q of paths) for (const [re, why] of PATH_RULES) if (re.test(q) && !(testFixtureSql && re === SCHEMA_FILE)) raise(2, `${why}: ${q}`);

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
        for (const [re, why] of ADDED_OR_REMOVED) if (re.test(l)) raise(2, `${why}: ${p}`);
      }
    }
  }
  if (!files.length) reasons.add('empty diff');
  return { tier, reasons: [...reasons].slice(0, 12) };
}

export function readRiskPaths(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, '.github', 'risk-paths.txt'), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

export const ghFileReader = (gh, repo, sha) => p =>
  gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`]);

function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 << 20 });
  let diff;
  let readFile = p => fs.readFileSync(path.join(run('git', ['rev-parse', '--show-toplevel']).trim(), p), 'utf8');
  if (opt('--pr')) {
    diff = run('gh', ['pr', 'diff', opt('--pr')]);
    const pr = JSON.parse(run('gh', ['pr', 'view', opt('--pr'), '--json', 'url,headRefOid']));
    readFile = ghFileReader(a => run('gh', a), repoOfUrl(pr.url), pr.headRefOid);
  } else {
    let base = opt('--base');
    if (!base) {
      try { base = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim(); } catch { base = 'origin/main'; }
    }
    diff = run('git', ['diff', '--no-color', `${base}...HEAD`]) + run('git', ['diff', '--no-color', 'HEAD']);
  }
  console.log(JSON.stringify(riskTier(diff, { extraPaths: readRiskPaths(process.cwd()), readFile }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
