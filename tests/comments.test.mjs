import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFiles, countSource, decodeSource } from '../plugins/bstack/scripts/comments.mjs';

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

test('a Rust char literal or raw string does not swallow the rest of the file', () => {
  const chars = "let q = s.trim_matches('\"'); // real comment\nlet t = \"x\";\n// second comment\nfn f() {}\n";
  assert.deepEqual(countSource('a.rs', chars), { comments: 2, suppressions: 0 });
  assert.deepEqual(countSource('a.rs', 'let p = r"C:\\dir\\"; // real\nlet q = "y"; // real2\n'), { comments: 2, suppressions: 0 });
  const mixed = [
    "let a = '\\''; // one", "let b = '\\n'; // two", "let c = b'\"'; // three",
    "fn f<'a>(x: &'a str) -> &'static str { x } // four",
    'let d = r#"a "quoted" // not"#; // five', 'let e = br"\\"; // six', 'let g = b"\\" // not"; // seven',
  ].join('\n');
  assert.deepEqual(countSource('a.rs', mixed), { comments: 7, suppressions: 0 });
});

test('a long single line with many strings counts in linear time', () => {
  const started = performance.now();
  assert.deepEqual(countSource('a.js', 'var a="x",b="y";'.repeat(90000)), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'a="x";b="""y""";'.repeat(90000)), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.js', `${'x=[/['.repeat(90000)}\n`), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'f"{'.repeat(90000)), { comments: 0, suppressions: 0 });
  assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
});

test('a triple-quoted argument on its own line is not a docstring', () => {
  assert.deepEqual(countSource('a.py', 'q = run(\n    """\n    SELECT 1\n    """\n)\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'x = [\n    """a""",\n]\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'class A:\n    """Doc."""\n'), { comments: 1, suppressions: 0 });
});

test('prose that mentions a suppression word is a comment, not a suppression', () => {
  assert.deepEqual(countSource('a.py', 'def f():\n    """Explain.\n\n    We never add noqa here.\n    """\n'), { comments: 4, suppressions: 0 });
  assert.deepEqual(countSource('a.js', '// we used to eslint-disable this\nx();\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'x = 1  # some text  # type: ignore\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.js', '/**\n * @ts-ignore old types\n */\nx();\n'), { comments: 0, suppressions: 3 });
  assert.deepEqual(countSource('a.js', 'x(); // eslint-disable-line no-console\n'), { comments: 0, suppressions: 1 });
});

test('file-wide type-check switches are suppressions; other type-checker settings are exempt', () => {
  assert.deepEqual(countSource('a.py', '# mypy: ignore-errors\nx = 1\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.py', '# mypy: disable-error-code="attr-defined"\nx = 1\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.py', '# pyright: reportMissingImports=false\nx = 1\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.py', '# pyright: basic, reportPrivateUsage=none\nx = 1\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.py', '# mypy: strict\n# pyright: strict\n# pyright: reportUnusedImport=true\nx = 1\n'), { comments: 0, suppressions: 0 });
});

test('a slash after a postfix increment or decrement is division', () => {
  assert.deepEqual(countSource('a.js', 'x = a++ / 2; // c\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.js', 'x = a-- / 2; // c\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.js', 'x = y + ++a / 2; // c\nz = [a--, /re/g]; // d\n'), { comments: 2, suppressions: 0 });
});

test('a quote inside an f-string replacement field starts a nested string', () => {
  assert.deepEqual(countSource('a.py', 'tags = f"{"#".join(xs)}"\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'a = F\'{d["#"]:{w}} {{# not}}\'  # c\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'b = rf"{ {"k": "#"}["k"] }" # c\n'), { comments: 1, suppressions: 0 });
});

test('a file-level ruff or flake8 noqa is a suppression', () => {
  assert.deepEqual(countSource('a.py', '# ruff: noqa: E501\nx = 1\n'), { comments: 0, suppressions: 1 });
  assert.deepEqual(countSource('a.py', '# flake8: noqa\nx = 1\n'), { comments: 0, suppressions: 1 });
});

test('a triple-quoted value after a colon inside brackets is not a docstring', () => {
  assert.deepEqual(countSource('a.py', 'HELP = {\n    "run":\n        """Run it.\n        Two lines."""\n}\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.py', 'def f(\n    a,\n) -> int:\n    """Doc."""\n'), { comments: 1, suppressions: 0 });
});

test('JSX text is not a regex or a line comment, and a JSX comment counts', () => {
  assert.deepEqual(countSource('a.jsx', 'const A = () => <div><p>x</p>{/* note */}</div>;\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.tsx', 'const L = () => <p>Docs: https://example.com</p>;\n'), { comments: 0, suppressions: 0 });
  assert.deepEqual(countSource('a.js', 'switch (x) {\n  case 1: // c\n    break;\n  default: // c\n}\n'), { comments: 2, suppressions: 0 });
});

test('a Rust block comment nests', () => {
  assert.deepEqual(countSource('a.rs', '/* outer\n   /* inner */\n   still outer\n*/\nfn main() {}\n'), { comments: 4, suppressions: 0 });
});

test('a Rust inner attribute on line 1 is not a shebang', () => {
  assert.deepEqual(countSource('a.rs', '#![allow(dead_code)] // kept for the FFI layer\n'), { comments: 1, suppressions: 1 });
  assert.deepEqual(countSource('a.rs', '#!/usr/bin/env run-cargo-script\n// c\nfn main() {}\n'), { comments: 1, suppressions: 0 });
});

test('a UTF-16 file is decoded by its byte order mark', () => {
  const text = '# a comment\r\n$x = 1 # another\r\n';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  assert.equal(decodeSource(le), text);
  assert.equal(decodeSource(be), text);
  assert.equal(decodeSource(Buffer.from(text)), text);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-comments-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ps1'), le);
    fs.writeFileSync(path.join(dir, 'b.ps1'), be);
    assert.deepEqual(countFiles(dir, ['a.ps1', 'b.ps1']), {
      'a.ps1': { comments: 2, suppressions: 0 },
      'b.ps1': { comments: 2, suppressions: 0 },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.equal(all.stderr, '4 comment lines and 1 suppression in 3 of 4 files\n');
    const some = run(dir, 'count', 'lib', 'untracked.py');
    assert.deepEqual(JSON.parse(some.stdout).total, { files: 2, comments: 2, suppressions: 1 });
    assert.equal(some.stderr, '2 comment lines and 1 suppression in 2 of 2 files\n');
    assert.equal(run(dir, 'count', 'src/a.mjs').stderr, '1 comment line and 0 suppressions in 1 of 1 file\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown command prints usage and exits 1', () => {
  const out = run(here, 'nope');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: comments\.mjs count/);
});
