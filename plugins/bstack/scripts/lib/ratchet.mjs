import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, countSource, decodeSource, syntaxFor } from '../comments.mjs';
import { UNRESOLVED, parseGit } from './shell.mjs';

const COMMENTS_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'comments.mjs').replace(/\\/g, '/');
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '-t', '--template',
  '--fixup', '--squash', '--author', '--date', '--cleanup', '--trailer']);
const PATHSPEC_FILE = '--pathspec-from-file';
const VALUE_SHORTS = 'mFCct';
const ATTACHED_SHORTS = 'Su';
const ZERO = /^0+$/;
const REGULAR = /^100(644|755)$/;
const REDIRECTION = /^[0-9&*]?(?:>[>|]?|<<-?|<>|<)&?(.*)$/s;

function redirectionLength(words, i) {
  const redirect = REDIRECTION.exec(words[i]);
  if (!redirect) return 0;
  return redirect[1] ? 1 : 2;
}

function withoutRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const skip = redirectionLength(words, i);
    if (skip) i += skip - 1;
    else out.push(words[i]);
  }
  return out;
}

export function parseCommit(rest) {
  const opts = { all: false, include: false, dryRun: false, paths: [], pathspecFile: null, pathspecNul: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const skip = redirectionLength(rest, i);
    if (skip) { i += skip - 1; continue; }
    if (a === '--') { opts.paths.push(...withoutRedirections(rest.slice(i + 1))); break; }
    if (VALUE_OPTS.has(a)) { i++; continue; }
    if (a === PATHSPEC_FILE) { opts.pathspecFile = rest[++i] ?? null; continue; }
    if (a.startsWith('--')) {
      if (a === '--all') opts.all = true;
      else if (a === '--include') opts.include = true;
      else if (a === '--dry-run') opts.dryRun = true;
      else if (a === '--pathspec-file-nul') opts.pathspecNul = true;
      else if (a.startsWith(`${PATHSPEC_FILE}=`)) opts.pathspecFile = a.slice(PATHSPEC_FILE.length + 1);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const flag = a[k];
        if (flag === 'a') opts.all = true;
        else if (flag === 'i') opts.include = true;
        if (VALUE_SHORTS.includes(flag)) { if (k === a.length - 1) i++; break; }
        if (ATTACHED_SHORTS.includes(flag)) break;
      }
      continue;
    }
    opts.paths.push(a);
  }
  return opts;
}

export function commentRatchet({ command, rest, prior, tool, unseen, looped }, shellDeps) {
  const opts = parseCommit(rest);
  if (opts.dryRun) return null;
  const target = commitTarget(command, shellDeps.host.paths);
  if (typeof target === 'string') return target;
  const { repo, gitEnv } = target;
  const deps = gitEnv ? { ...shellDeps, git: (cwd, args, o = {}) => shellDeps.git(cwd, args, { ...o, env: { ...gitEnv, ...o.env } }) } : shellDeps;
  opts.paths.push(...pathspecsFromFile(repo, opts, deps));
  let root, realIndex;
  try {
    [root, realIndex] = deps.git(repo, ['rev-parse', '--show-toplevel', '--git-path', 'index']).trim().split('\n').map(s => s.trim());
  } catch { return null; }
  realIndex = path.resolve(repo, realIndex);
  if (!deps.exists(path.join(root, BASELINE)) && !inIndex(root, {}, deps)) return null;
  if (unseen) return `bstack cannot see what git am commits: its patches are not in the index when the guard runs, so it cannot check the comment baseline. Apply each patch with git apply --index, then run the commit in its own call.`;
  if (looped) return `bstack checks the comment baseline once, before the command line runs, so it cannot see what a loop changes between its commits. Run the commit in its own call, once per commit.`;

  const replays = prior.filter(p => p.cmd === 'git' && Object.hasOwn(INDEX_REPLAYS, parseGit(p.args).sub));
  const unsafe = prior.find(p => !safeBeforeCommit(p, tool, shellDeps)) ?? (gitEnv ? replays[0] : undefined);
  if (unsafe) return ownCall(unsafe);
  const rebuild = replays.length || opts.all || opts.paths.length;
  const temp = rebuild ? path.join(os.tmpdir(), `bstack-ratchet-${process.pid}-${Date.now()}.index`) : null;
  const env = temp ? { GIT_INDEX_FILE: temp } : {};
  try {
    if (temp) {
      if (deps.exists(realIndex)) fs.copyFileSync(realIndex, temp);
      for (const command of replays) replay(command, { repo, root, tool }, env, deps);
      if (opts.all) onTempIndex(repo, ['add', '-u'], env, deps);
      else if (opts.paths.length) onTempIndex(repo, ['add', '-u', '--', ...opts.paths], env, deps);
    }
    return check(root, repo, opts, env, deps);
  } finally {
    if (temp) for (const f of [temp, `${temp}.lock`]) fs.rmSync(f, { force: true });
  }
}

const GIT_LOCATION = { gitDir: 'GIT_DIR', workTree: 'GIT_WORK_TREE' };

function commitTarget({ args, expressions, cwd, dialect, env = {} }, paths) {
  const parsed = parseGit(args, expressions);
  if (cwd === null) return unknownRepo('a cd to a path the guard cannot resolve');
  if (!parsed.dirKnown) return unknownRepo(`-C ${parsed.dir}`);
  const redirect = redirectsRepo(parsed, env);
  if (redirect) return unknownRepo(redirect);
  const repo = parsed.dir === null ? cwd : paths.resolvePath(cwd, parsed.dir, dialect);
  const gitEnv = {};
  for (const [option, name] of Object.entries(GIT_LOCATION)) {
    const value = parsed[option] ?? env[name];
    if (value === undefined || value === null) continue;
    if (UNRESOLVED.test(value)) return unknownRepo(`${name} ${value}`);
    gitEnv[name] = paths.resolvePath(repo, value, dialect);
  }
  return { repo, gitEnv: Object.keys(gitEnv).length ? gitEnv : null };
}

const UNFOLLOWED_ENV = ['GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

function redirectsRepo({ config }, env = {}) {
  return UNFOLLOWED_ENV.find(name => env[name] !== undefined) ?? (config.includes('core.worktree') ? 'core.worktree' : null);
}

function unknownRepo(what) {
  return `bstack cannot tell which repository or index this commit uses (${what}), so it cannot check the comment baseline. Write the path out, or cd there and run the commit in its own call.`;
}

function ownCall(command) {
  return `bstack checks the comment baseline before the command line runs, so it cannot see what \`${command.text}\` changes first. Run that on its own, then the commit in its own call.`;
}

const SAFE_COMMANDS = new Set(['', 'echo', 'printf', 'write-output', 'write-host', 'true', 'false', ':', 'test', 'test-path', '[', 'fi', 'done', 'esac',
  'export', 'pwd', 'get-location', 'ls', 'dir', 'get-childitem', 'gci', 'cat', 'type', 'get-content', 'gc', 'grep', 'rg', 'findstr',
  'select-string', 'sls', 'jq', 'less', 'head', 'tail', 'wc', 'cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'push-location', 'pop-location']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe', 'shortlog', 'branch', 'fetch']);
const SUBSTITUTION = { Bash: /\$\(|`|[<>]\(/, PowerShell: /\$\(/ };
const OUTPUT_REDIRECT = /^.*?[0-9*&]?>[>|]?(&?)(.*)$/s;
const DISCARD = /^(\/dev\/null|\$null|nul)$/i;
const GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE'];
const QUOTED_ENV_SET = /^\$env:\w+\s*=\s*("[^"]*"|'[^']*')$/i;

function safeBeforeCommit(c, tool, deps) {
  if ((SUBSTITUTION[tool] ?? SUBSTITUTION.Bash).test(c.text) || writesFile(c.args)) return false;
  if (c.cmd === 'git') {
    const parsed = parseGit(c.args, c.expressions);
    const { dir, dirKnown, gitDir, workTree, sub, rest } = parsed;
    if (READ_ONLY_GIT.has(sub)) return !rest.some(a => a.startsWith('--output'));
    if (!Object.hasOwn(INDEX_REPLAYS, sub) || c.cwd === null || gitDir !== null || workTree !== null) return false;
    if (!dirKnown || GIT_ENV.some(name => c.env?.[name] !== undefined) || redirectsRepo(parsed, c.env)) return false;
    const where = dir === null ? c.cwd : deps.host.paths.resolvePath(c.cwd, dir, c.dialect);
    return INDEX_REPLAYS[sub](withoutRedirections(rest), { where, shellCwd: c.cwd, tool }, deps).length > 0;
  }
  if (c.text.startsWith('$')) return QUOTED_ENV_SET.test(c.text) || !c.text.includes('=');
  return SAFE_COMMANDS.has(c.cmd) || /^-[a-z]+$/i.test(c.cmd);
}

function writesFile(words) {
  return words.some((w, i) => {
    const redirect = OUTPUT_REDIRECT.exec(w);
    return redirect && !redirect[1] && !DISCARD.test(redirect[2] || words[i + 1] || '');
  });
}

function pathspecsFromFile(repo, { pathspecFile, pathspecNul }, deps) {
  if (!pathspecFile || pathspecFile === '-') return [];
  const text = deps.readFile(path.resolve(repo, pathspecFile)) ?? '';
  return text.split(pathspecNul ? '\0' : /\r?\n/).filter(Boolean);
}

const INDEX_REPLAYS = { add: addArgs, stage: addArgs, restore: restoreArgs, rm: rmArgs, reset: resetArgs };
const MOVES_HEAD_OR_TREE = /^--(soft|hard|merge|keep)$/;
const NOT_EMULATED = /^(-p|--patch|--pathspec-from-file(=.*)?)$/;

function replay(command, { repo, root, tool }, env, deps) {
  const { dir, sub, rest } = parseGit(command.args);
  const where = dir ? deps.host.paths.resolvePath(command.cwd, dir, command.dialect) : command.cwd;
  if (where !== repo) {
    let top;
    try { top = deps.git(where, ['rev-parse', '--show-toplevel']).trim(); } catch { return; }
    if (path.resolve(top) !== path.resolve(root)) return;
  }
  const words = withoutRedirections(rest);
  for (const args of INDEX_REPLAYS[sub](words, { where, shellCwd: command.cwd, tool }, deps)) onTempIndex(where, args, env, deps);
}

function onTempIndex(cwd, args, env, deps) {
  if (!env.GIT_INDEX_FILE) return;
  try { deps.git(cwd, args, { env: { ...env, ...NO_EDITOR }, timeout: 45000 }); } catch {}
}

const NO_EDITOR = { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' };
const INTERACTIVE_ADD = /^(--(interactive|patch|edit)|-[a-zA-Z]*[ipe][a-zA-Z]*)$/;

function addArgs(words, { shellCwd, tool }) {
  if (beforeDashes(words).some(w => INTERACTIVE_ADD.test(w))) return [];
  return [['add', ...(tool === 'Bash' ? words.flatMap(w => bashGlob(w, shellCwd)) : words)]];
}

function restoreArgs(words) {
  const options = beforeDashes(words);
  const staged = hasFlag(options, '--staged', 'S');
  const worktree = hasFlag(options, '--worktree', 'W');
  return staged && !worktree ? [['restore', ...words]] : [];
}

function rmArgs(words) {
  return [['rm', ...(beforeDashes(words).includes('--cached') ? [] : ['--cached']), ...words]];
}

function resetArgs(words, { where }, deps) {
  const dashes = words.indexOf('--');
  const options = beforeDashes(words);
  if (options.some(w => MOVES_HEAD_OR_TREE.test(w) || NOT_EMULATED.test(w))) return [];
  const positional = options.filter(w => !w.startsWith('-'));
  const isCommit = arg => {
    try { deps.git(where, ['rev-parse', '--verify', '-q', `${arg}^{commit}`]); return true; } catch { return false; }
  };
  let source, paths;
  if (dashes >= 0) [source, paths] = [positional[0], words.slice(dashes + 1)];
  else if (positional.length && isCommit(positional[0])) [source, paths] = [positional[0], positional.slice(1)];
  else paths = positional;
  if (!paths.length) return source === undefined ? [['read-tree', 'HEAD']] : [];
  return [['restore', '--staged', ...(source === undefined ? [] : [`--source=${source}`]), '--', ...paths]];
}

function beforeDashes(words) {
  const dashes = words.indexOf('--');
  return dashes < 0 ? words : words.slice(0, dashes);
}

function hasFlag(options, long, short) {
  return options.some(w => w === long || (/^-[a-zA-Z]+$/.test(w) && w.includes(short)));
}

const GLOB_CHAR = /[*?[]/;

function bashGlob(word, base) {
  if (!GLOB_CHAR.test(word)) return [word];
  let found = [{ shown: null, real: base }];
  for (const segment of word.split('/')) {
    found = found.flatMap(at => segmentMatches(segment, at.real).map(name => ({
      shown: at.shown === null ? name : `${at.shown}/${name}`,
      real: at.shown === null ? path.resolve(base, `${name}/`) : path.join(at.real, name),
    })));
  }
  return found.length ? found.map(f => f.shown).sort() : [word];
}

function segmentMatches(segment, dir) {
  if (segment === '') return isDirectory(dir) ? [''] : [];
  if (!GLOB_CHAR.test(segment)) return fs.existsSync(path.join(dir, segment)) ? [segment] : [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const pattern = segmentPattern(segment);
  return names.filter(name => pattern.test(name) && (segment.startsWith('.') || !name.startsWith('.')));
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function segmentPattern(segment) {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') { source += '.*'; continue; }
    if (ch === '?') { source += '.'; continue; }
    if (ch === '[') {
      const negate = segment[i + 1] === '!' || segment[i + 1] === '^';
      const from = i + 1 + (negate ? 1 : 0);
      const close = segment.indexOf(']', from + 1);
      if (close >= 0) {
        source += `[${negate ? '^' : ''}${segment.slice(from, close).replace(/[\\\]^[]/g, '\\$&')}]`;
        i = close;
        continue;
      }
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's');
}

function inIndex(root, env, deps) {
  try { deps.git(root, ['cat-file', '-e', `:${BASELINE}`], { env }); return true; } catch { return false; }
}

function check(root, repo, opts, env, deps) {
  if (!inIndex(root, env, deps)) return null;
  let limits;
  try {
    limits = readBaseline(deps.git(root, ['show', `:${BASELINE}`], { env }).replace(/^﻿/, ''));
  } catch (e) {
    return `${BASELINE} is not valid (${String(e.message ?? e).split('\n')[0]}). Regenerate it with node "${COMMENTS_SCRIPT}" baseline.`;
  }
  const only = opts.paths.length && !opts.include && !opts.all;
  let raw;
  try {
    raw = deps.git(repo, ['diff', '--cached', '--raw', '-z', '-M', '--no-color', ...(only ? ['--', ...opts.paths] : [])], { env });
  } catch (e) {
    return `bstack could not read the staged changes to check the comment baseline (${String(e.message ?? e).split('\n')[0]}). The check fails closed.`;
  }
  const changed = parseRaw(raw).filter(r => r.status !== 'D' && REGULAR.test(r.dstMode) && syntaxFor(r.path));
  if (!changed.length) return null;
  const counts = countBlobs(root, changed.map(r => ({ object: r.dstSha, path: r.path })), deps);
  const over = changed.map((r, k) => ({ ...r, now: counts[k], base: Math.max(limits[r.path] ?? 0, r.from ? limits[r.from] ?? 0 : 0) }))
    .filter(r => r.now > r.base);
  const known = over.filter(r => !ZERO.test(r.srcSha) && REGULAR.test(r.srcMode));
  const before = countBlobs(root, known.map(r => ({ object: r.srcSha, path: r.from ?? r.path })), deps);
  known.forEach((r, k) => { r.head = before[k]; });
  let refused = over.filter(r => r.now > (r.head ?? 0));
  for (const side of refused.length ? inProgressSides(root, deps) : []) {
    const theirs = countBlobs(root, refused.map(r => ({ object: `${side}:${r.path}`, path: r.path })), deps);
    refused = refused.filter((r, k) => r.now > theirs[k]);
  }
  return refused.length ? refusal(refused) : null;
}

const IN_PROGRESS_SIDES = ['CHERRY_PICK_HEAD', 'REVERT_HEAD^', 'REBASE_HEAD'];

function inProgressSides(root, deps) {
  let mergeHeads = [];
  try {
    const file = path.resolve(root, deps.git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
    mergeHeads = (deps.readFile(file) ?? '').split(/\s+/).filter(Boolean);
  } catch {}
  return [...mergeHeads, ...IN_PROGRESS_SIDES.flatMap(ref => {
    try { return [deps.git(root, ['rev-parse', '-q', '--verify', ref]).trim()]; } catch { return []; }
  })];
}

function readBaseline(text) {
  const data = JSON.parse(text);
  const files = data?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('expected {"files": {"<path>": <comment lines>}}');
  for (const [file, n] of Object.entries(files)) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`${file}: ${JSON.stringify(n)} is not a count`);
  }
  return files;
}

function parseRaw(raw) {
  const parts = raw.split('\0');
  const out = [];
  for (let k = 0; k < parts.length;) {
    const head = parts[k++];
    if (!head.startsWith(':')) continue;
    const [srcMode, dstMode, srcSha, dstSha, status] = head.slice(1).split(' ');
    const kind = status[0];
    const first = parts[k++];
    const second = kind === 'R' || kind === 'C' ? parts[k++] : null;
    out.push({ srcMode, dstMode, srcSha, dstSha, status: kind, path: second ?? first, from: kind === 'R' ? first : null });
  }
  return out;
}

function countBlobs(root, blobs, deps) {
  if (!blobs.length) return [];
  const buf = deps.git(root, ['cat-file', '--batch'], { input: `${blobs.map(b => b.object).join('\n')}\n`, buffer: true });
  const counts = [];
  let at = 0;
  for (const blob of blobs) {
    const eol = buf.indexOf(0x0a, at);
    const [, type, size] = buf.subarray(at, eol).toString('utf8').split(' ');
    if (type === 'missing') { counts.push(0); at = eol + 1; continue; }
    if (type !== 'blob') throw new Error(`git cat-file could not read ${blob.path}`);
    const body = buf.subarray(eol + 1, eol + 1 + Number(size));
    at = eol + 1 + Number(size) + 1;
    counts.push(countSource(blob.path, decodeSource(body))?.comments ?? 0);
  }
  return counts;
}

function refusal(files) {
  const lines = files.map(f => `  ${f.path}: baseline ${f.base}, this commit ${f.now}${f.head > f.base ? ` (${f.head} before it)` : ''}`);
  return [
    `This commit adds comment lines over ${BASELINE}:`,
    ...lines,
    'Remove them instead: rename or extract so the code says it, or encode the constraint as a test, type or runtime check.',
    `A comment about something outside this code (a third-party API, a browser or library bug) may stay, prefixed external: with proof. Then run node "${COMMENTS_SCRIPT}" baseline first, as its own command, then stage and commit the new baseline with it: this check runs before the whole command line, so a baseline written by the same line is not seen.`,
    `After a cleanup, run the same baseline command, again on its own, to lower the baseline.`,
  ].join('\n');
}
