#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `usage: comments.mjs count [paths...]   comment lines and suppressions per file and in total (JSON on stdout, summary on stderr)
       comments.mjs baseline           write .github/comment-baseline.json for the tracked files of this repo`;

const str = (open, escape = '\\', multiline = false, close = open) => ({ open, escape, multiline, close });
const doc = open => ({ ...str(open, '\\', true), doc: true });
const pattern = (open, close) => ({ open, close, escape: null, multiline: true });

export const SYNTAX = {
  py: {
    line: ['#'],
    strings: [doc('"""'), doc("'''"), str('"'), str("'")],
    prefixes: /^[rbuf]{1,2}$/i,
    docstrings: true,
    directives: [/^type:/, /^(pyright|mypy):/, /^-\*-.*-\*-$/],
    encoding: /coding[:=]\s*[-\w.]+/,
  },
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    strings: [str('`', '\\', true), str('"'), str("'")],
    regex: true,
    lineNotAfter: /[a-z]:$/i,
    directives: [/^@ts-check\b/, /^@flow\b/, /^\/\s*<reference\b/, /^eslint-env\b/],
  },
  css: { block: [['/*', '*/']], strings: [str('"'), str("'")] },
  html: { block: [['<!--', '-->']], strings: [] },
  sh: {
    line: ['#'],
    wordStart: true,
    strings: [
      pattern(/(?<!<)<<(?<!\(\((?:(?!\)\))[^\n])*<<)(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/y, m => new RegExp(`\\n${m[1] ? '\\t*' : ''}${m[3]}(?=\\n|$)`, 'y')),
      str("$'", '\\', true, "'"),
      str('"', '\\', true),
      str("'", null, true),
    ],
    directives: [/^shellcheck\s+(shell|source)=/],
  },
  ps1: {
    line: ['#'],
    block: [['<#', '#>']],
    wordStart: true,
    strings: [
      pattern(/@(['"])[ \t]*(?=\n)/y, m => new RegExp(`\\n${m[1]}@`, 'y')),
      str('"', '`', true),
      str("'", null, true),
    ],
    directives: [/^requires\s+-/i],
  },
  yml: {
    line: ['#'],
    wordStart: true,
    quoteWordStart: true,
    strings: [str('"'), str("'", null)],
    directives: [/^yaml-language-server:/],
  },
  sql: { line: ['--'], block: [['/*', '*/']], strings: [str("'", null, true), str('"', null, true)] },
  rs: {
    line: ['//'],
    block: [['/*', '*/']],
    nestedBlock: true,
    strings: [
      pattern(/b?r(#*)"/y, m => `"${m[1]}`),
      str('"', '\\', true),
      pattern(/'(?:[^'\\\n]|\\(?:x[0-9a-f]{2}|u\{[0-9a-f]{1,6}\}|.))'/iuy, () => ''),
    ],
    prefixes: /^b$/,
    codeSuppression: /^\s*#!?\[allow\(/,
  },
};

export const EXTENSIONS = {
  py: 'py', pyi: 'py',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', mts: 'js', cts: 'js', tsx: 'js',
  css: 'css', html: 'html', htm: 'html', sh: 'sh', bash: 'sh', ps1: 'ps1', psm1: 'ps1',
  yml: 'yml', yaml: 'yml', sql: 'sql', rs: 'rs',
};

export const SUPPRESSIONS = [
  /^((ruff|flake8):\s*)?noqa\b/i, /^type:\s*ignore\b/, /^pyright:\s*ignore\b/, /^pylint:\s*disable/, /^eslint-disable/,
  /^@ts-(ignore|expect-error|nocheck)\b/, /^shellcheck\s+disable=/, /^yamllint\s+disable/,
  /^mypy:\s*(ignore-errors|disable-error-code)\b/, /^pyright:.*\breport\w+\s*=\s*(false|none)\b/i,
];
const LICENCE = /copyright\b|\(c\)\s*\d{4}|SPDX-License-Identifier|licensed under|all rights reserved|permission is hereby granted/i;
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%>~^');
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
const DOC_TAIL = /[ \t]*(#|\n|$)/y;
const FSTRING_LEVELS = 150;

export function decodeSource(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))).swap16().toString('utf16le');
  return buf.toString('utf8');
}

export const syntaxFor = file => SYNTAX[EXTENSIONS[path.extname(file).slice(1).toLowerCase()]] ?? null;

export function countSource(file, text) {
  const syntax = syntaxFor(file);
  return syntax ? countText(text, syntax) : null;
}

export function countText(text, syntax) {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const found = findComments(src, syntax);
  const lines = { comment: new Set(), suppression: new Set() };
  classify(found, syntax).forEach((kind, k) => {
    for (let l = found[k].from; l <= found[k].to; l++) lines[kind]?.add(l);
  });
  if (syntax.codeSuppression) src.split('\n').forEach((l, k) => syntax.codeSuppression.test(l) && lines.suppression.add(k));
  return { comments: lines.comment.size, suppressions: lines.suppression.size };
}

function findComments(src, syn) {
  const n = src.length;
  const newlines = [];
  for (let k = 0; k < n; k++) if (src[k] === '\n') newlines.push(k);
  const lineOf = offset => {
    let lo = 0, hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const lineStart = k => (lineOf(k) ? newlines[lineOf(k) - 1] + 1 : 0);
  const lineEnd = k => newlines[lineOf(k)] ?? n;
  const startsWord = k => k === 0 || /[\s;|&()]/.test(src[k - 1]);
  const startsValue = k => k === 0 || /[\s[{,:]/.test(src[k - 1]);
  const opener = (list, k) => list?.find(m => src.startsWith(typeof m === 'string' ? m : m[0], k) && (!syn.wordStart || startsWord(k)));
  const ahead = new Map();
  const closesAhead = (close, from) => {
    const seen = ahead.get(close.source);
    if (seen && seen.from <= from && (seen.at < 0 || seen.at >= from)) return seen.at >= 0;
    const re = new RegExp(close.source, 'g');
    re.lastIndex = from;
    const at = re.exec(src)?.index ?? -1;
    ahead.set(close.source, { from, at });
    return at >= 0;
  };
  const stringAt = k => {
    for (const s of syn.strings) {
      if (typeof s.open === 'string') {
        if (src.startsWith(s.open, k)) return { s, body: k + s.open.length, close: s.close };
        continue;
      }
      s.open.lastIndex = k;
      const m = s.open.exec(src);
      const close = m && s.close(m);
      if (m && (typeof close === 'string' || closesAhead(close, k + m[0].length))) return { s, body: k + m[0].length, close };
    }
    return null;
  };

  const found = [];
  let code = false, prev = '', word = '', lastEnd = -1, regexFailsBefore = -1, depth = 0;
  const push = (from, stop, body) => found.push({ from: lineOf(from), to: lineOf(Math.max(from, stop - 1)), body, header: !code });
  const operand = () => prev === 's' || prev === ')' || prev === ']' || (prev === 'w' && !REGEX_AFTER_WORD.has(word));
  const isDocstring = (token, stop) => {
    DOC_TAIL.lastIndex = stop;
    return (!code || (prev === ':' && depth === 0)) && lastEnd < lineStart(token) && DOC_TAIL.test(src);
  };

  const closesAt = (close, k) => {
    if (typeof close === 'string') return src.startsWith(close, k) ? k + close.length : -1;
    close.lastIndex = k;
    return close.test(src) ? close.lastIndex : -1;
  };

  const skipString = (k, s, close, fmt, level = 0) => {
    while (k < n) {
      const end = closesAt(close, k);
      if (end >= 0) return end;
      if (src[k] === '\n' && !s.multiline) return k;
      if (fmt && src[k] === '{' && level < FSTRING_LEVELS) k = src[k + 1] === '{' ? k + 2 : skipField(k + 1, level + 1);
      else k += src[k] === s.escape ? 2 : 1;
    }
    return n;
  };

  const skipField = (k, level) => {
    let open = 1;
    while (k < n && open) {
      let j = k;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(k, j);
      const nested = (j === k || syn.prefixes?.test(w)) && stringAt(j);
      if (nested) k = skipString(nested.body, nested.s, nested.close, /f/i.test(w), level);
      else if (j > k) k = j;
      else {
        open += src[k] === '{' ? 1 : src[k] === '}' ? -1 : 0;
        k++;
      }
    }
    return k;
  };

  const readString = (token, { s, body, close }, fmt = false) => {
    const stop = skipString(body, s, close, fmt);
    if (syn.docstrings && s.doc && isDocstring(token, stop)) {
      push(token, stop, src.slice(body, Math.max(body, stop - close.length)));
    } else {
      code = true;
      prev = 's';
    }
    return stop;
  };

  const nestedClose = ([open, close], k) => {
    let level = 1;
    while (k < n) {
      if (src.startsWith(close, k)) {
        if (--level === 0) return k;
        k += close.length;
      } else if (src.startsWith(open, k)) {
        level++;
        k += open.length;
      } else k++;
    }
    return -1;
  };

  const readRegex = start => {
    if (start < regexFailsBefore) return start + 1;
    let k = start + 1, inClass = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '\n') {
        regexFailsBefore = k;
        return start + 1;
      }
      if (ch === '\\') { k += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      k++;
    }
    k++;
    while (k < n && /[a-z]/i.test(src[k])) k++;
    return k;
  };

  const step = i => {
    const c = src[i];
    const block = opener(syn.block, i);
    if (block) {
      const close = syn.nestedBlock ? nestedClose(block, i + block[0].length) : src.indexOf(block[1], i + block[0].length);
      const stop = close < 0 ? n : close + block[1].length;
      push(i, stop, src.slice(i + block[0].length, close < 0 ? n : close));
      return stop;
    }
    const line = opener(syn.line, i);
    if (line && !syn.lineNotAfter?.test(src.slice(Math.max(0, i - 2), i))) {
      const stop = lineEnd(i);
      push(i, stop, src.slice(i + line.length, stop));
      return stop;
    }
    const quoted = stringAt(i);
    if (quoted && (!syn.quoteWordStart || startsValue(i))) return readString(i, quoted);
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      const prefixed = syn.prefixes?.test(w) && stringAt(j);
      if (prefixed) return readString(i, prefixed, /f/i.test(w));
      code = true;
      prev = 'w';
      word = w;
      return j;
    }
    code = true;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (syn.regex && c === '/' && (prev === '' || REGEX_AFTER.has(prev) || (prev === 'w' && REGEX_AFTER_WORD.has(word)))) {
      const stop = readRegex(i);
      prev = stop > i + 1 ? 's' : '/';
      return stop;
    }
    if (syn.regex && (c === '+' || c === '-') && src[i + 1] === c && operand()) {
      prev = ')';
      return i + 2;
    }
    prev = c;
    return i + 1;
  };

  let i = /^#!(?!\[)/.test(src) ? lineEnd(0) : 0;
  while (i < n) {
    if (/\s/.test(src[i])) { i++; continue; }
    i = step(i);
    lastEnd = i;
  }
  return found;
}

function classify(found, syn) {
  const licensed = new Set();
  let group = [];
  const flush = () => {
    if (group.some(f => LICENCE.test(f.body))) group.forEach(f => licensed.add(f));
    group = [];
  };
  for (const f of found) {
    if (!f.header) break;
    if (group.length && f.from > group.at(-1).to + 1) flush();
    group.push(f);
  }
  flush();
  const firstLine = body => body.split('\n').map(l => l.replace(/^[\s*]+/, '')).find(Boolean) ?? '';
  const segments = line => (syn.line ?? []).reduce((parts, m) => parts.flatMap(p => p.split(m)), [line]);
  const suppresses = body => segments(firstLine(body)).some(seg => SUPPRESSIONS.some(re => re.test(seg.trimStart())));
  return found.map(f => {
    const text = f.body.trim();
    if (suppresses(f.body)) return 'suppression';
    if (licensed.has(f) || /SPDX-License-Identifier/.test(text)) return 'exempt';
    if (f.from < 2 && syn.encoding?.test(text)) return 'exempt';
    if (syn.directives?.some(re => re.test(text))) return 'exempt';
    return 'comment';
  });
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
const tracked = (cwd, paths = []) => git(['ls-files', '-z', '--', ...paths], cwd).split('\0').filter(Boolean);
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function listFiles(cwd, paths = []) {
  const files = paths.length
    ? paths.flatMap(p => (fs.statSync(path.resolve(cwd, p)).isFile() ? [path.relative(cwd, path.resolve(cwd, p))] : tracked(cwd, [p])))
    : tracked(cwd);
  return [...new Set(files.map(f => f.replace(/\\/g, '/')))].filter(syntaxFor).sort(byPath);
}

export function countFiles(cwd, files) {
  const out = {};
  for (const f of files) {
    let text;
    try {
      text = decodeSource(fs.readFileSync(path.join(cwd, f)));
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') continue;
      throw e;
    }
    out[f] = countSource(f, text);
  }
  return out;
}

export function count(cwd, paths = []) {
  const counted = Object.entries(countFiles(cwd, listFiles(cwd, paths)));
  const sum = key => counted.reduce((acc, [, c]) => acc + c[key], 0);
  return {
    files: Object.fromEntries(counted.filter(([, c]) => c.comments || c.suppressions)),
    total: { files: counted.length, comments: sum('comments'), suppressions: sum('suppressions') },
  };
}

export const BASELINE = '.github/comment-baseline.json';

export function writeBaseline(cwd) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const counted = countFiles(root, listFiles(root));
  const files = Object.fromEntries(Object.entries(counted).map(([f, c]) => [f, c.comments]));
  const target = path.join(root, BASELINE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ files }, null, 2)}\n`);
  return { path: target, files: Object.keys(files).length, comments: Object.values(files).reduce((a, b) => a + b, 0) };
}

const plural = (amount, noun) => `${amount} ${noun}${amount === 1 ? '' : 's'}`;

function main() {
  const [cmd, ...paths] = process.argv.slice(2);
  const cwd = process.cwd();
  if (cmd === 'count') {
    const result = count(cwd, paths);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const { total } = result;
    process.stderr.write(`${plural(total.comments, 'comment line')} and ${plural(total.suppressions, 'suppression')} in ${Object.keys(result.files).length} of ${plural(total.files, 'file')}\n`);
  } else if (cmd === 'baseline' && !paths.length) {
    const out = writeBaseline(cwd);
    process.stderr.write(`wrote ${BASELINE}: ${plural(out.comments, 'comment line')} in ${plural(out.files, 'file')}\n`);
  } else {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    process.stderr.write(`comments: ${String(e.stderr || e.message || e).trim().split('\n')[0]}\n`);
    process.exit(1);
  }
}
