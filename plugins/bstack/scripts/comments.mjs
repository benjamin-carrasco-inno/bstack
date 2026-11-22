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
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
const QUOTE_AFTER_WORD = new Set([...REGEX_AFTER_WORD, 'from', 'import']);
const unglued = open => ({ ...str(open), afterWord: QUOTE_AFTER_WORD });
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const SYNTAX = {
  py: {
    line: ['#'],
    strings: [doc('"""'), doc("'''"), str('"'), str("'")],
    prefixes: /^[rbuft]{1,2}$/i,
    field: { prefix: /[ft]/i, open: '{', literal: '{{', spec: ':' },
    docstrings: true,
    directives: [/^type:/, /^(pyright|mypy):/, /^-\*-.*-\*-$/],
    encoding: /coding[:=]\s*[-\w.]+/,
  },
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    strings: [{ ...str('`', '\\', true), field: { open: '${' } }, unglued('"'), unglued("'")],
    regex: true,
    lineNotAt: /(?<=[a-z]:)\/\/\S/iy,
    directives: [
      /^@ts-check\b/, /^@flow\b/, /^\/\s*<reference\b/, /^eslint-env\b/, /^[#@]\s*source(Mapping)?URL=/,
      /^@jsx(Frag|ImportSource|Runtime)?\s/, /^[#@]__(PURE|NO_SIDE_EFFECTS)__$/, /^webpack[A-Z]\w*\s*:/,
    ],
    blockDirectives: [/^(globals?|exported)\s/, /^eslint\s+[\w@/-]+\s*:/],
  },
  css: { block: [['/*', '*/']], strings: [str('"'), str("'")], directives: [/^#\s*sourceMappingURL=/] },
  html: { block: [['<!--', '-->']], strings: [] },
  sh: {
    line: ['#'],
    wordStart: true,
    strings: [
      pattern(/(?<!<)<<(?<!\(\((?:(?!\)\))[^\n])*<<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][^\s;&|<>()'"\\]*))/y, m => new RegExp(`\\n${m[1] ? '\\t*' : ''}${literal(m[2] ?? m[3] ?? m[4])}(?=\\n|$)`, 'y')),
      str("$'", '\\', true, "'"),
      str('"', '\\', true),
      str("'", null, true),
    ],
    directives: [/^shellcheck\s+(shell|source|source-path|enable|external-sources)=/],
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
    codeSuppression: /#!?\[\s*((allow|expect)\s*\(|rustfmt::skip\b|cfg_attr\s*\([^\]\n#]*?\b(allow|expect)\s*\()/y,
  },
};

export const EXTENSIONS = {
  py: 'py', pyi: 'py',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', mts: 'js', cts: 'js', tsx: 'js',
  css: 'css', html: 'html', htm: 'html', sh: 'sh', bash: 'sh', ps1: 'ps1', psm1: 'ps1',
  yml: 'yml', yaml: 'yml', sql: 'sql', rs: 'rs',
};

export const SUPPRESSIONS = [
  /^((ruff|flake8):\s*)?noqa\b/i, /^type:\s*ignore\b/, /^pyright:\s*ignore\b/, /^pylint:\s*(disable|skip-file)/, /^(eslint|oxlint)-disable/,
  /^@ts-(ignore|expect-error|nocheck)\b/, /^shellcheck\s+disable=/, /^yamllint\s+disable/,
  /^mypy:\s*(ignore-errors|disable-error-code)\b/, /^pyright:.*\breport\w+\s*=\s*(false|none)\b/i,
  /^nosec\b/, /^pragma[:\s]?\s*no\s*(cover|branch)\b/i, /^(fmt|yapf|isort):\s*(off|skip|disable|skip_file)\b/,
  /^stylelint-disable/, /^eslint\s+(.*[\s,])?[\w@/-]+\s*:\s*\[?\s*(["']?)(off|0)\2(?![\w.])/,
  /^biome-ignore(-all|-start)?\s+(lint|format|assist|syntax)\b/, /^prettier-ignore\b/, /^deno-lint-ignore(-file)?\b/,
  /^(istanbul\s+ignore\s+(next|if|else|file)|(c8|v8)\s+ignore\s+(next|start|file)|node:coverage\s+(ignore\s+next|disable))\b/,
];
const RESUMES = [
  /^(eslint|oxlint|stylelint)-enable\b/, /^(c8|v8)\s+ignore\s+stop\b/, /^node:coverage\s+enable\b/, /^biome-ignore-end\b/,
  /^(fmt|yapf|isort):\s*(on|enable)\b/, /^pylint:\s*enable\b/, /^yamllint\s+enable\b/,
];
const SPDX = /SPDX-(License-Identifier|FileCopyrightText)/i;
const LICENCE = new RegExp(`copyright\\s*(\\(c\\)|©)?\\s*\\d{4}|(\\(c\\)|©)\\s*\\d{4}|${SPDX.source}|licensed under\\b.*\\blicen[cs]e|all rights reserved|permission is hereby granted|@license\\b`, 'i');
const YEARS = String.raw`\d{4}(\s*[-–,]\s*(\d{4}|present))*,?`;
const HOLDER_WORD = String.raw`((inc|ltd|corp|co|llc|\p{L})\.|<[^\s<>]+>|([^\s.,;:!?]|\.(?=[^\s.,;:!?]))+)`;
const HOLDER_WORDS = 10;
const LICENCE_ID = String.raw`[\w.+()-]+`;
const LICENCE_LINES = [
  new RegExp(String.raw`^(copyright\s*(\(c\)|©)(\s*${YEARS})?|copyright\s+${YEARS}|(\(c\)|©)(\s*${YEARS})?),?\s+${HOLDER_WORD}(,?\s+${HOLDER_WORD}){0,${HOLDER_WORDS - 1}}\.?(\s+all rights reserved\.?)?$`, 'u'),
  /^all rights reserved\.?$/,
  /^spdx-(license-identifier|filecopyrighttext):\s*\S/,
  new RegExp(String.raw`^@license(\s+${LICENCE_ID}(\s+(and|or|with)\s+${LICENCE_ID})*)?$`),
  /^[^\p{L}\p{N}]*$/u,
];
const BSD_CLAUSES = [
  'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:',
  '1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.',
  '2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.',
];
const BSD_DISCLAIMER = 'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.';
const gnuHeader = name => [
  `This program is free software: you can redistribute it and/or modify it under the terms of the GNU ${name} License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.`,
  `This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU ${name} License for more details.`,
  `You should have received a copy of the GNU ${name} License along with this program. If not, see <https://www.gnu.org/licenses/>.`,
];
const LICENCE_TEXTS = {
  MIT: [
    'MIT License',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ],
  'Apache-2.0': [
    'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at',
    'https://www.apache.org/licenses/LICENSE-2.0',
    'Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.',
  ],
  'BSD-2-Clause': ['BSD 2-Clause License', ...BSD_CLAUSES, BSD_DISCLAIMER],
  'BSD-3-Clause': [
    'BSD 3-Clause License', ...BSD_CLAUSES,
    '3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.',
    BSD_DISCLAIMER,
  ],
  'GPL-3.0': gnuHeader('General Public'),
  'LGPL-3.0': gnuHeader('Lesser General Public'),
  'AGPL-3.0': gnuHeader('Affero General Public'),
  'MIT pointer': [
    'This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.',
    'Licensed under the MIT License. See License.txt in the project root for license information.',
    'Licensed under the MIT License. See LICENSE in the project root for license information.',
  ],
  'BSD pointer': ['This source code is licensed under the BSD-style license found in the LICENSE file in the root directory of this source tree.'],
  'MPL-2.0': ['This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.'],
};
const words = line => line.replace(/^[\s*#/!]+/, '').trim().replace(/\s+/g, ' ').toLowerCase();
const PARAGRAPHS = Object.values(LICENCE_TEXTS).flat().flatMap(p => [p, p.replaceAll('https://', 'http://')]).map(p => ` ${words(p)} `);
const LICENCE_RUN_WORDS = 6;
const inLicence = run => PARAGRAPHS.some(p => p.includes(` ${run} `));

function licenceLines(group) {
  const entries = group.flatMap(f => f.body.split('\n').map((raw, k) => ({ line: f.from + k, text: words(raw) })));
  const exempt = new Set(entries.filter(e => LICENCE_LINES.some(re => re.test(e.text))).map(e => e.line));
  let whole = false;
  for (let k = 0; k < entries.length;) {
    let m = k, run = '';
    while (m < entries.length && /[\p{L}\p{N}]/u.test(entries[m].text) && inLicence(run ? `${run} ${entries[m].text}` : entries[m].text)) {
      run = run ? `${run} ${entries[m].text}` : entries[m].text;
      m++;
    }
    const complete = run !== '' && PARAGRAPHS.includes(` ${run} `);
    if (complete || run.split(' ').length >= LICENCE_RUN_WORDS) entries.slice(k, m).forEach(e => exempt.add(e.line));
    whole ||= complete;
    k = Math.max(m, k + 1);
  }
  return whole || group.some(f => LICENCE.test(f.body)) ? exempt : null;
}
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%>~^');
const POSTFIX = [/\+\+/y, /--/y, /(?<=[\w$)\]!])!/y];
const DOC_TAIL = /[ \t]*(#|\n|$)/y;
const FIELD_LEVELS = 150;
const SPEC = { escape: null, multiline: true };

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
  const { kinds, exempt } = classify(found, syntax);
  kinds.forEach((kind, k) => {
    for (let l = found[k].from; l <= found[k].to; l++) {
      if (kind !== 'licence') lines[kind]?.add(l);
      else if (!exempt.has(l)) lines.comment.add(l);
    }
  });
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
  let code = false, prev = '', word = '', lastEnd = -1, regexFailsBefore = -1, depth = 0, fieldLevel = 0;
  const push = (from, stop, body, kind) => found.push({ from: lineOf(from), to: lineOf(Math.max(from, stop - 1)), body, kind, header: !code });
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

  const skipString = (k, s, close, field) => {
    while (k < n) {
      const end = closesAt(close, k);
      if (end >= 0) return end;
      if (src[k] === '\n' && !s.multiline) return k;
      if (field?.literal && src.startsWith(field.literal, k)) k += field.literal.length;
      else if (field && src.startsWith(field.open, k) && fieldLevel < FIELD_LEVELS) k = skipField(k + field.open.length, field);
      else k += src[k] === s.escape ? 2 : 1;
    }
    return n;
  };

  const skipField = (k, field) => {
    const saved = { code, prev, word, depth };
    fieldLevel++;
    code = true;
    prev = '{';
    while (k < n) {
      if (/\s/.test(src[k])) k++;
      else if (depth === saved.depth && src[k] === '}') { k++; break; }
      else if (depth === saved.depth && src[k] === field.spec) { k = skipString(k + 1, SPEC, '}', field); break; }
      else k = step(k);
    }
    fieldLevel--;
    ({ code, prev, word, depth } = saved);
    return k;
  };

  const readString = (token, { s, body, close }, prefix = '') => {
    const stop = skipString(body, s, close, s.field ?? (syn.field?.prefix.test(prefix) ? syn.field : null));
    if (syn.docstrings && s.doc && isDocstring(token, stop)) {
      push(token, stop, src.slice(body, Math.max(body, stop - close.length)), 'block');
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
    if (syn.codeSuppression && closesAt(syn.codeSuppression, i) >= 0) {
      code = true;
      push(i, i + 1, '', 'suppression');
    }
    const block = opener(syn.block, i);
    if (block) {
      const close = syn.nestedBlock ? nestedClose(block, i + block[0].length) : src.indexOf(block[1], i + block[0].length);
      const stop = close < 0 ? n : close + block[1].length;
      push(i, stop, src.slice(i + block[0].length, close < 0 ? n : close), 'block');
      return stop;
    }
    const line = opener(syn.line, i);
    if (line && !(syn.lineNotAt && closesAt(syn.lineNotAt, i) >= 0)) {
      const stop = lineEnd(i);
      push(i, stop, src.slice(i + line.length, stop), 'line');
      return stop;
    }
    const quoted = stringAt(i);
    const glued = quoted?.s.afterWord && i > 0 && /[\w$]/.test(src[i - 1]) && !quoted.s.afterWord.has(word);
    if (quoted && !glued && (!syn.quoteWordStart || startsValue(i))) return readString(i, quoted);
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      const prefixed = syn.prefixes?.test(w) && stringAt(j);
      if (prefixed) return readString(i, prefixed, w);
      code = true;
      prev = 'w';
      word = w;
      return j;
    }
    code = true;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    const selfClose = prev === '}' && src[i + 1] === '>';
    if (syn.regex && c === '/' && !selfClose && (prev === '' || REGEX_AFTER.has(prev) || (prev === 'w' && REGEX_AFTER_WORD.has(word)))) {
      const stop = readRegex(i);
      prev = stop > i + 1 ? 's' : '/';
      return stop;
    }
    const postfix = syn.regex && operand() ? POSTFIX.map(re => closesAt(re, i)).find(end => end >= 0) : undefined;
    if (postfix !== undefined) {
      prev = ')';
      return postfix;
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
  const headers = new Set();
  const exempt = new Set();
  const licence = items => {
    const lines = items.length ? licenceLines(items) : null;
    lines?.forEach(l => exempt.add(l));
    return Boolean(lines);
  };
  let group = [];
  const flush = () => {
    if (licence(group)) group.forEach(f => headers.add(f));
    group = [];
  };
  for (const f of found) {
    if (!f.header) break;
    if (group.length && (f.kind !== 'line' || group[0].kind !== 'line' || f.from > group.at(-1).to + 1)) flush();
    group.push(f);
  }
  flush();
  const firstLine = body => body.split('\n').map(l => l.replace(/^[\s*]+/, '')).find(Boolean) ?? '';
  const segments = line => (syn.line ?? []).reduce((parts, m) => parts.flatMap(p => p.split(m)), [line]);
  const suppresses = body => segments(firstLine(body)).some(seg => SUPPRESSIONS.some(re => re.test(seg.trimStart())));
  const kinds = found.map(f => {
    const text = f.body.trim().replace(/^\*+\s*/, '');
    if (f.kind === 'suppression' || suppresses(f.body)) return 'suppression';
    if (f.from < 2 && syn.encoding?.test(text)) return 'exempt';
    if (syn.directives?.some(re => re.test(text)) || RESUMES.some(re => re.test(text))) return 'exempt';
    if (f.kind === 'block' && syn.blockDirectives?.some(re => re.test(text))) return 'exempt';
    return headers.has(f) || (SPDX.test(text) && licence([f])) ? 'licence' : 'comment';
  });
  return { kinds, exempt };
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
