import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countSource } from '../plugins/bstack/scripts/comments.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'comments');
const script = path.join(here, '..', 'plugins', 'bstack', 'scripts', 'comments.mjs');

const HAND_COUNTED = {
  'sample.py': { comments: 6, suppressions: 2 },
  'sample.js': { comments: 5, suppressions: 1 },
  'sample.ts': { comments: 1, suppressions: 2 },
  'sample.css': { comments: 5, suppressions: 0 },
  'sample.html': { comments: 5, suppressions: 0 },
  'sample.sh': { comments: 2, suppressions: 1 },
  'sample.ps1': { comments: 6, suppressions: 0 },
  'sample.yml': { comments: 3, suppressions: 1 },
  'sample.sql': { comments: 4, suppressions: 0 },
  'sample.rs': { comments: 3, suppressions: 2 },
};

for (const [file, expected] of Object.entries(HAND_COUNTED)) {
  test(`${file} matches the hand count`, () => {
    assert.deepEqual(countSource(file, fs.readFileSync(path.join(fixtures, file), 'utf8')), expected);
  });
}

test('every fixture file is hand counted', () => {
  assert.deepEqual(fs.readdirSync(fixtures).sort(), Object.keys(HAND_COUNTED).sort());
});

test('exempt lines are not counted', () => {
  const py = '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# Copyright 2026 Example Authors\n# All rights reserved.\n\nx: int = 1  # type: int\n';
  assert.deepEqual(countSource('a.py', py), { comments: 0, suppressions: 0 });
  const js = '#!/usr/bin/env node\n// @ts-check\n/// <reference types="node" />\n/* eslint-env node */\nconst x = 1; // SPDX-License-Identifier: MIT\n';
  assert.deepEqual(countSource('a.mjs', js), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.ps1', '#Requires -Version 7\n$x = 1\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', '#!/bin/sh\n# shellcheck shell=sh\ntrue\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.yml', '# yaml-language-server: $schema=x.json\na: 1\n'), { comments: 0, suppressions: 0 });
});

test('a licence comment after code, or not in the header group, counts', () => {
  assert.deepEqual(countSource('a.py', 'x = 1\n# Copyright 2026 Example Authors\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', '# Copyright 2026 Example Authors\n\n# What this module does.\nx = 1\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'x = 1\ny = 2\n# coding: utf-8\n'), { comments: 1, suppressions: 0 });
});

test('suppressions are counted in their own field, not as comments', () => {
  const cases = [
    ['a.py', 'import x  # noqa: F401\n'],
    ['a.py', 'y = x  # type: ignore[attr-defined]\n'],
    ['a.py', 'y = x  # pyright: ignore\n'],
    ['a.py', 'y = x  # pylint: disable=invalid-name\n'],
    ['a.js', '/* eslint-disable no-console */\nconsole.log(1);\n'],
    ['a.ts', '// @ts-ignore\nconst y = x;\n'],
    ['a.ts', '// @ts-nocheck\nconst y = x;\n'],
    ['a.sh', '# shellcheck disable=SC2086\necho $x\n'],
    ['a.rs', '#[allow(dead_code)]\nfn f() {}\n'],
  ];
  for (const [file, text] of cases) assert.deepEqual(countSource(file, text), { comments: 0, suppressions: 1 }, text);
});

test('a comment marker inside a string literal is not counted', () => {
  const py = [
    'a = "# not"', "b = '# not'", 'c = r"\\"# not"', 'd = f"{a} # not"', 'e = b"# not"',
    'f = """', '# not', '"""', 'g = "escaped \\" # still a string"',
  ].join('\n');
  assert.deepEqual(countSource('a.py', py), { comments: 0, suppressions: 0 });
  const js = [
    "const a = '// not';", 'const b = "/* not */";', 'const c = `// not ${a} /* not */`;',
    "const d = 'it\\'s // not';", 'const e = /\\/\\/ not/g.test(a) ? 4 / 2 : 1;', 'const f = a.split(/[/*]/);',
  ].join('\n');
  assert.deepEqual(countSource('a.mjs', js), { comments: 0, suppressions: 0 });
});

test('a docstring counts; a triple-quoted string that is not a statement does not', () => {
  assert.deepEqual(countSource('a.py', 'def f():\n    """One.\n\n    Three."""\n'), { comments: 3, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'def f():\n    r"""Raw docstring."""  # and a comment\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'x = """\nnot\n"""\ny = f("""a""", 1)\n'), { comments: 0, suppressions: 0 });
});

test('CRLF and a byte order mark give the same counts as LF', () => {
  const text = fs.readFileSync(path.join(fixtures, 'sample.py'), 'utf8');
  assert.deepEqual(countSource('a.py', `﻿${text.replace(/\n/g, '\r\n')}`), HAND_COUNTED['sample.py']);
});

test('an unknown file type is not counted', () => {
  assert.equal(countSource('README.md', '# heading'), null);
  assert.equal(countSource('data.json', '{}'), null);
});

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-comments-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('src/b.py', 'x = 1  # one\n# two\n');
  write('src/a.mjs', 'const a = 1; // one\n');
  write('src/clean.css', '.a { color: red; }\n');
  write('lib/z.sh', '# one\n# shellcheck disable=SC2086\necho $1\n');
  write('README.md', '# not counted\n');
  write('untracked.py', '# not tracked\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', 'src', 'lib', 'README.md'], { cwd: dir });
  return dir;
}

const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('baseline writes the stated shape for tracked files, sorted by path, and is byte-stable', () => {
  const dir = fixtureRepo();
  try {
    const first = run(path.join(dir, 'src'), 'baseline');
    assert.equal(first.status, 0, first.stderr);
    const file = path.join(dir, '.github', 'comment-baseline.json');
    const bytes = fs.readFileSync(file);
    assert.deepEqual(JSON.parse(bytes), { files: { 'lib/z.sh': 1, 'src/a.mjs': 1, 'src/b.py': 2, 'src/clean.css': 0 } });
    assert.deepEqual(Object.keys(JSON.parse(bytes).files), ['lib/z.sh', 'src/a.mjs', 'src/b.py', 'src/clean.css']);
    assert.match(first.stderr, /wrote \.github\/comment-baseline\.json: 4 comment lines in 4 files/);
    assert.equal(run(dir, 'baseline').status, 0);
    assert.ok(fs.readFileSync(file).equals(bytes), 'second run gives identical bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('count prints JSON per file and in total, with a summary line on stderr', () => {
  const dir = fixtureRepo();
  try {
    const all = run(dir, 'count');
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(JSON.parse(all.stdout), {
      files: {
        'lib/z.sh': { comments: 1, suppressions: 1 },
        'src/a.mjs': { comments: 1, suppressions: 0 },
        'src/b.py': { comments: 2, suppressions: 0 },
      },
      total: { files: 4, comments: 4, suppressions: 1 },
    });
    assert.equal(all.stderr, '4 comment lines and 1 suppressions in 3 of 4 files\n');
    const some = run(dir, 'count', 'lib', 'untracked.py');
    assert.deepEqual(JSON.parse(some.stdout).total, { files: 2, comments: 2, suppressions: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown command prints usage and exits 1', () => {
  const out = run(here, 'nope');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: comments\.mjs count/);
});
