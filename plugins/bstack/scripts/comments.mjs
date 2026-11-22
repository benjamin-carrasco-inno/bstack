#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `usage: comments.mjs count [paths...]   comment lines and suppressions per file and in total (JSON on stdout, summary on stderr)
       comments.mjs baseline           write .github/comment-baseline.json for the tracked files of this repo`;

const str = (open, escape = '\\', multiline = false) => ({ open, escape, multiline });

export const SYNTAX = {
  py: {
    line: ['#'],
    strings: [str('"""', '\\', true), str("'''", '\\', true), str('"'), str("'")],
    prefixes: /^[rbuf]{1,2}$/i,
    docstrings: true,
    directives: [/^type:/, /^(pyright|mypy):/, /^-\*-.*-\*-$/],
  },
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    strings: [str('`', '\\', true), str('"'), str("'")],
    regex: true,
    directives: [/^@ts-check\b/, /^@flow\b/, /^\/\s*<reference\b/, /^eslint-env\b/],
  },
  css: { block: [['/*', '*/']], strings: [str('"'), str("'")] },
  html: { block: [['<!--', '-->']], strings: [] },
  sh: {
    line: ['#'],
    wordStart: true,
    strings: [str('"', '\\', true), str("'", null, true)],
    directives: [/^shellcheck\s+(shell|source)=/],
  },
  ps1: {
    line: ['#'],
    block: [['<#', '#>']],
    wordStart: true,
    strings: [str('"', '`', true), str("'", null, true)],
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
  rs: { line: ['//'], block: [['/*', '*/']], strings: [str('"', '\\', true)], codeSuppression: /^\s*#!?\[allow\(/ },
};

export const EXTENSIONS = {
  py: 'py', pyi: 'py',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', mts: 'js', cts: 'js', tsx: 'js',
  css: 'css', html: 'html', htm: 'html', sh: 'sh', bash: 'sh', ps1: 'ps1', psm1: 'ps1',
  yml: 'yml', yaml: 'yml', sql: 'sql', rs: 'rs',
};

export const SUPPRESSIONS = [
  /\bnoqa\b/i, /\btype:\s*ignore\b/, /\bpyright:\s*ignore\b/, /\bpylint:\s*disable/, /\beslint-disable/,
  /@ts-(ignore|expect-error|nocheck)\b/, /\bshellcheck\s+disable=/, /\byamllint\s+disable/,
];
const ENCODING = /coding[:=]\s*[-\w.]+/;
const LICENCE = /copyright\b|\(c\)\s*\d{4}|SPDX-License-Identifier|licensed under|all rights reserved|permission is hereby granted/i;
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

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
  const lineEnd = k => (src.indexOf('\n', k) < 0 ? n : src.indexOf('\n', k));
  const startsWord = k => k === 0 || /[\s;|&()]/.test(src[k - 1]);
  const startsValue = k => k === 0 || /[\s[{,:]/.test(src[k - 1]);
  const opener = (list, k) => list?.find(m => src.startsWith(typeof m === 'string' ? m : m[0], k) && (!syn.wordStart || startsWord(k)));
  const stringAt = k => syn.strings.find(s => src.startsWith(s.open, k));

  const found = [];
  let code = false, prev = '', word = '';
  const push = (from, stop, body) => found.push({ from: lineOf(from), to: lineOf(Math.max(from, stop - 1)), body, header: !code });

  const readString = (token, quote) => {
    const s = stringAt(quote);
    let k = quote + s.open.length, stop = n;
    while (k < n) {
      if (src.startsWith(s.open, k)) { stop = k + s.open.length; break; }
      if (src[k] === '\n' && !s.multiline) { stop = k; break; }
      k += src[k] === s.escape ? 2 : 1;
    }
    const alone = src.slice(src.lastIndexOf('\n', token - 1) + 1, token).trim() === '';
    if (syn.docstrings && s.open.length === 3 && alone && /^[ \t]*(#.*)?$/.test(src.slice(stop, lineEnd(stop)))) {
      push(token, stop, src.slice(quote + 3, Math.max(quote + 3, stop - 3)));
    } else {
      code = true;
      prev = 's';
    }
    return stop;
  };

  const readRegex = start => {
    let k = start + 1, inClass = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '\n') return start + 1;
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

  let i = src.startsWith('#!') ? lineEnd(0) : 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const block = opener(syn.block, i);
    if (block) {
      const close = src.indexOf(block[1], i + block[0].length);
      const stop = close < 0 ? n : close + block[1].length;
      push(i, stop, src.slice(i + block[0].length, close < 0 ? n : close));
      i = stop;
      continue;
    }
    const line = opener(syn.line, i);
    if (line) {
      const stop = lineEnd(i);
      push(i, stop, src.slice(i + line.length, stop));
      i = stop;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (syn.prefixes?.test(w) && stringAt(j)) { i = readString(i, j); continue; }
      code = true;
      prev = 'w';
      word = w;
      i = j;
      continue;
    }
    if (stringAt(i) && (!syn.quoteWordStart || startsValue(i))) { i = readString(i, i); continue; }
    if (syn.regex && c === '/' && (prev === '' || REGEX_AFTER.has(prev) || (prev === 'w' && REGEX_AFTER_WORD.has(word)))) {
      const stop = readRegex(i);
      code = true;
      prev = stop > i + 1 ? 's' : '/';
      i = stop;
      continue;
    }
    code = true;
    prev = c;
    i++;
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
  return found.map(f => {
    const text = f.body.trim();
    if (SUPPRESSIONS.some(re => re.test(text))) return 'suppression';
    if (licensed.has(f) || /SPDX-License-Identifier/.test(text)) return 'exempt';
    if (f.from < 2 && ENCODING.test(text)) return 'exempt';
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
      text = fs.readFileSync(path.join(cwd, f), 'utf8');
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

function main() {
  const [cmd, ...paths] = process.argv.slice(2);
  const cwd = process.cwd();
  if (cmd === 'count') {
    const result = count(cwd, paths);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const { total } = result;
    process.stderr.write(`${total.comments} comment lines and ${total.suppressions} suppressions in ${Object.keys(result.files).length} of ${total.files} files\n`);
  } else if (cmd === 'baseline' && !paths.length) {
    const out = writeBaseline(cwd);
    process.stderr.write(`wrote ${BASELINE}: ${out.comments} comment lines in ${out.files} files\n`);
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
