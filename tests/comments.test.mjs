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
  'sample.js': { comments: 6, suppressions: 1 },
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

const LINEAR_INPUTS = {
  'js strings': ['a.js', 'var a="x",b="y";'.repeat(90000), 0],
  'py strings': ['a.py', 'a="x";b="""y""";'.repeat(90000), 0],
  'js unclosed regex classes': ['a.js', `${'x=[/['.repeat(90000)}\n`, 0],
  'py unclosed f-string fields': ['a.py', 'f"{'.repeat(90000), 0],
  'js unclosed template fields': ['a.js', '`${'.repeat(90000), 0],
  'sh arithmetic shifts': ['a.sh', 'a=$((b << c))\n'.repeat(75000), 0],
  'sh heredocs without a delimiter line': ['a.sh', 'cat <<NOPE\n'.repeat(90000), 0],
  'rs unclosed attributes': ['a.rs', '#[cfg_attr(a, b('.repeat(90000), 0],
  'py licence header with narration': ['a.py', `# Copyright 2024 Acme\n${'# the software is provided as is\n'.repeat(5000)}`, 5000],
};

for (const [name, [file, text, comments]] of Object.entries(LINEAR_INPUTS)) {
  test(`a long input counts in linear time: ${name}`, () => {
    const started = performance.now();
    assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, name);
    const took = performance.now() - started;
    assert.ok(took < 2000, `${name} took ${Math.round(took)} ms`);
  });
}

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

test('a sh heredoc body is a string, closed only by its delimiter on a line of its own', () => {
  const script = "#!/usr/bin/env bash\nusage() {\n  cat <<EOF\nUsage: deploy.sh [env]\nDon't run this on prod.\n# not a comment\nEOF\n}\n# Pick the target.\nTARGET=${1:-dev}\n# Build first.\nmake build # quiet\n# Then upload.\nscp out \"$TARGET:/srv\"\n";
  assert.deepEqual(countSource('a.sh', script), { comments: 4, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', "cat <<'EOF'\n# a\nEOF not yet\n  EOF\nEOF\n# one\n"), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', 'cat <<"EOF"\n# b\nEOF\n# two\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', '\tcat <<-EOF\n\t# c\n\t\tEOF\n# three\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', 'cat << END_X\n# d\nEND_X\n# four\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', 'cat <<< EOF\n# one\nEOF\n# two\n'), { comments: 2, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', 'echo $((1 << 2))\n# one\n2\n# two\n'), { comments: 2, suppressions: 0 });
});

test('a sh << in arithmetic or without its delimiter line is an operator, not a heredoc', () => {
  assert.deepEqual(countSource('a.sh', 'echo $((x << y))\n# one\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', '(( x <<= 2 ))\n# two\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', 'cat <<NOPE\necho hi\n# three\n'), { comments: 1, suppressions: 0 });
});

test('a PowerShell here-string body is a string', () => {
  const single = "$help = @'\nThis script can't be undone.\n# not a comment\n'@\n# Step one.\nWrite-Output $help\n# Step two.\n$x = 1 # trailing\n";
  assert.deepEqual(countSource('a.ps1', single), { comments: 3, suppressions: 0 });
  const double = '$m = @"\nA "quote # not a comment\n"@\n# real\n$y = "x" # trailing\n';
  assert.deepEqual(countSource('a.ps1', double), { comments: 2, suppressions: 0 });
});

test('a sh ANSI-C quoted string takes backslash escapes', () => {
  assert.deepEqual(countSource('a.sh', "echo $'don\\'t'\n# real\n"), { comments: 1, suppressions: 0 });
});

test('the encoding-line exemption applies only to Python', () => {
  assert.deepEqual(countSource('a.js', '// Output encoding: utf-8 is assumed\nx = 1\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.sh', '#!/bin/sh\n# coding: utf-8\ntrue\n'), { comments: 1, suppressions: 0 });
  assert.deepEqual(countSource('a.py', '#!/usr/bin/env python3\n# vim: set fileencoding=utf-8 :\nx = 1\n'), { comments: 0, suppressions: 0 });
});

test('a replacement field in a JS template literal or a Python f- or t-string follows code rules', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.js', "const s = `${a ? `// ${a}` : ''}`;\nconst t = 1;\n// real comment\nconst u = `x`;\n", 1);
  at('a.js', "const s = `${a ? `// ${a}` : ''}`;\nconst t = 1;\n", 0);
  at('a.js', "const s = `${a ? `/* x */` : ''}`;\nconst t = 1;\n", 0);
  at('a.js', "const s = `${`'`}`; // c\nconst x = 'y';\n", 1);
  at('a.js', "const s = `${`${`${'`'}`}`}`; // c\n", 1);
  at('a.js', "const s = `${ {a: '`'}.a } // not`; // c\n", 1);
  at('a.js', "const s = `a ${x.replace(/[`}]/g, '')} // not`; // c\n", 1);
  at('a.js', "const s = `${'}'} // not`; // c\n", 1);
  at('a.js', 'const s = `\\${a // not}`; // c\n', 1);
  at('a.js', 'const s = `${a /* c */}`;\n', 1);
  at('a.js', 'const s = `${a // c\n}`;\n', 1);
  at('a.py', 't"{"#"}"\n', 0);
  at('a.py', 'a = f"{x:#x} {y!r:>{w}}"  # c\n', 1);
  at('a.py', 'a = f"{x:\'>10}"  # c\nb = 1  # d\n', 2);
  at('a.py', 'a = f"""{x  # c\n}"""\n', 1);
});

test('only a real licence statement exempts, and only its own run of line comments or its own block', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.py', '# Copyright 2024 X\n"""Parse the config.\n\nLong explanation.\n"""\nx = 1\n', 4);
  at('a.js', '// Copyright 2024 X\n/**\n * Explains the module.\n */\nexport const x = 1;\n', 3);
  at('a.py', '# Bump the copyright year in every file.\n# Walks the tree and rewrites headers.\nimport os\n', 2);
  at('a.py', '# Copyright 2024 X\n# Licensed under the Apache License, Version 2.0\n# you may not use this file except in compliance.\n', 1);
  at('a.py', '# Copyright 2024 X\n# Licensed under the Apache License, Version 2.0\n# (the "License"); you may not use this file except in compliance with the License.\n', 0);
  at('a.py', '# Copyright 2024 X\n"""Doc."""\n# More notes.\nx = 1\n', 2);
  at('a.py', '# Copyright holders may reuse this.\nx = 1\n', 1);
  at('a.py', '"""Copyright 2024 X. All rights reserved."""\nx = 1\n', 0);
  at('a.js', '/* Copyright (c) 2024 X */\n// Explains the module.\nexport const x = 1;\n', 1);
  at('a.js', '/*\n * © 2019-2024 X\n * Released as is.\n */\n/** Module doc. */\nexport const x = 1;\n', 2);
  at('a.js', '/* Bump the copyright year. */\nx = 1;\n', 1);
  at('a.js', '// Permission is hereby granted, free of charge.\n/** @module x */\n', 2);
  at('a.css', '/* Copyright © 2024 X */\n/* Layout for the header. */\n.a {}\n', 1);
  at('a.html', '<!-- All rights reserved. -->\n<!-- Page layout. -->\n<p></p>\n', 1);
});

const APACHE_HEADER = [
  'Copyright 2024 Acme Corp', '',
  'Licensed under the Apache License, Version 2.0 (the "License");',
  'you may not use this file except in compliance with the License.',
  'You may obtain a copy of the License at', '',
  '    http://www.apache.org/licenses/LICENSE-2.0', '',
  'Unless required by applicable law or agreed to in writing, software',
  'distributed under the License is distributed on an "AS IS" BASIS,',
  'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
  'See the License for the specific language governing permissions and',
  'limitations under the License.',
];
const MIT_LICENCE = [
  'MIT License', '', 'Copyright (c) 2024 Acme Corp', '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:', '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.', '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
];
const MPL_HEADER = [
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
];
const hashed = lines => lines.map(l => (l ? `# ${l}` : '#')).join('\n');
const starred = lines => `/*\n${lines.map(l => (l ? ` * ${l}` : ' *')).join('\n')}\n */`;

test('a licence header exempts only its licence lines; any other line in the same group or block counts', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.py', '"""Fetch photos licensed under CC-BY from Flickr.\n\nLong explanation\nmore narration\n"""\nimport x\n', 5);
  at('a.py', '# SPDX-License-Identifier: MIT\n# This function works around a bug\n# so do not remove it\nimport x\n', 2);
  at('a.js', '// Copyright 2024 Acme\n// HACK: this is a workaround, do not touch\nimport x from "y";\n', 1);
  at('a.py', `${hashed(APACHE_HEADER)}\nimport os\n`, 0);
  at('a.js', `${starred(MIT_LICENCE)}\nexport const x = 1;\n`, 0);
  at('a.py', `${hashed(MIT_LICENCE)}\nimport os\n`, 0);
  at('a.js', `${APACHE_HEADER.map(l => `// ${l}`.trimEnd()).join('\n')}\n// Parses the config and caches it.\nexport const x = 1;\n`, 1);
  at('a.js', '/*\n * Copyright 2024 Acme\n * HACK: works around a parser bug\n */\nx();\n', 1);
  at('a.py', '"""Copyright 2024 Acme.\n\nThis module parses the config.\n"""\n', 1);
  at('a.py', '# Licensed under the MIT license\n# Do not remove this branch\nx = 1\n', 2);
  at('a.py', '# licensed under CC-BY\n# more narration\nx = 1\n', 2);
  at('a.py', '# Copyright 2024 Acme\n# keep this as is, it is a hack\nx = 1\n', 1);
  at('a.py', '# Copyright 2024 Acme\n# See the issue tracker: this works around a bug\nx = 1\n', 1);
  at('a.js', 'x();\n/* SPDX-License-Identifier: MIT\n * narration hidden behind the tag\n */\n', 1);
  at('a.js', '// Copyright 2024 Acme\n// -----\n//\nx();\n', 0);
});

test('a licence header exempts only copyright, SPDX, verbatim licence text and marker-only lines', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.js', "// Copyright 2024 Acme Inc. All rights reserved.\n// Checks the user's permission before an upload is accepted.\n// Retries are distributed over three workers; see https://wiki.example/upload.\n// Returns the upload id.\nexport const x = 1;\n", 3);
  at('a.py', '# Copyright 2024 Acme\n# See https://example.com/design for the algorithm.\nx=1\n', 1);
  at('a.py', '# Copyright 2024 Acme. Retries uploads twice.\nx = 1\n', 1);
  at('a.py', '# Copyright 2024 Acme retries every upload three times because the API is flaky\nx = 1\n', 1);
  at('a.py', '# Copyright 2024 Acme\n# All rights reserved.\n# Warranty: none, the config is distributed as is.\nx = 1\n', 1);
  at('a.py', '# Copyright (C) 2019-2024 Free Software Foundation, Inc.\n# Copyright 2024, Acme <dev@acme.example>\nx = 1\n', 0);
  at('a.py', '# SPDX-License-Identifier: MIT\n# SPDX-FileCopyrightText: 2024 Acme\nx = 1\n', 0);
  at('a.py', '# SPDX-FileCopyrightText: 2024 Acme\n# Explains the module.\nx = 1\n', 1);
  at('a.js', '// Copyright 2024 Acme\n// the\n// software\nx();\n', 2);
  at('a.js', '// Copyright 2024 Acme\n// Permission is hereby granted, free of charge, to any person who reviews this.\nx();\n', 1);
  at('a.py', `${hashed(['Copyright 2024 Acme', '', ...MPL_HEADER.slice(0, 2), 'Retries are handled by the worker pool.', MPL_HEADER[2]])}\nx = 1\n`, 1);
});

test('a standard copyright line is exempt with or without a year, with holder abbreviations, contacts and a rights clause', () => {
  const lines = [
    'Copyright (c) Microsoft Corporation. All rights reserved.',
    'Copyright (c) Microsoft Corporation.',
    'Copyright (c) 2020-2024 Acme Inc. and contributors',
    'Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>',
    'Copyright 2024 J. R. Smith',
    'Copyright 2015-present, Facebook, Inc.',
    'Copyright (c) Meta Platforms, Inc. and affiliates.',
    '© Acme Corp & Partners Ltd.',
    'Copyright 2019, 2021, 2024 Acme <dev@acme.example>',
  ];
  for (const line of lines) {
    for (const [file, mark] of [['a.py', '#'], ['a.js', '//']]) {
      const text = `${mark} ${line}\n${mark} SPDX-License-Identifier: MIT\nx = 1;\n`;
      assert.deepEqual(countSource(file, text), { comments: 0, suppressions: 0 }, text);
    }
  }
});

test('narration in a copyright line still counts: a second sentence, no year or symbol, or too many holder words', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.py', '# Copyright (c) Acme. Retries uploads twice.\n# SPDX-License-Identifier: MIT\nx = 1\n', 1);
  at('a.js', '// Copyright 2024 Acme Widgets. Do not edit this file by hand.\n// SPDX-License-Identifier: MIT\nx();\n', 1);
  at('a.py', '# Copyright holders may reuse this.\n# SPDX-License-Identifier: MIT\nx = 1\n', 1);
  at('a.py', '# Copyright (c) Acme retries every failed upload three times because the storage API is flaky\n# SPDX-License-Identifier: MIT\nx = 1\n', 1);
  at('a.js', '// Copyright (c) Acme Inc. All rights reserved. Retries twice.\n// SPDX-License-Identifier: MIT\nx();\n', 1);
});

const META_HEADER = licence => [
  'Copyright (c) Meta Platforms, Inc. and affiliates.', '',
  `This source code is licensed under the ${licence} found in the`,
  'LICENSE file in the root directory of this source tree.',
];
const MICROSOFT_HEADER = file => [
  '/*---------------------------------------------------------------------------------------------',
  ' *  Copyright (c) Microsoft Corporation. All rights reserved.',
  ` *  Licensed under the MIT License. See ${file} in the project root for license information.`,
  ' *--------------------------------------------------------------------------------------------*/',
].join('\n');

test('a standard one-line licence pointer is exempt; narration after it counts', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  for (const licence of ['MIT license', 'BSD-style license']) {
    at('a.js', `${slashed(META_HEADER(licence))}\nexport const x = 1;\n`, 0);
    at('a.js', `${starred(META_HEADER(licence))}\nexport const x = 1;\n`, 0);
    at('a.py', `${hashed(META_HEADER(licence))}\nx = 1\n`, 0);
  }
  for (const file of ['License.txt', 'LICENSE']) at('a.ts', `${MICROSOFT_HEADER(file)}\nexport const x = 1;\n`, 0);
  at('a.js', '// Licensed under the MIT License. See License.txt in the project root for license information.\n// HACK: keep this\nx();\n', 1);
  at('a.js', `${slashed([...META_HEADER('MIT license'), 'Retries are handled by the worker pool.'])}\nx();\n`, 1);
  at('a.js', '// This source code is licensed under the GPL found in the LICENSE file in the root directory of this source tree.\nx();\n', 1);
});

test('a JSDoc @license line holding only the tag and a licence id is exempt; narration with it counts', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.js', '/** @license MIT */\nexport const x = 1;\n', 0);
  at('a.js', '/*! @license Apache-2.0 */\nexport const x = 1;\n', 0);
  at('a.js', '/**\n * @license MIT OR Apache-2.0\n */\nexport const x = 1;\n', 0);
  at('a.js', '/**\n * @license\n * Retries uploads twice.\n * Do not remove.\n */\nexport const x = 1;\n', 2);
  at('a.js', '/** @license */\n// Retries uploads twice.\n// Do not remove.\nexport const x = 1;\n', 2);
  at('a.js', '/** @license MIT because the vendor asked */\nexport const x = 1;\n', 1);
});

const slashed = lines => lines.map(l => (l ? `// ${l}` : '//')).join('\n');
const BSD_CLAUSES = [
  'Redistribution and use in source and binary forms, with or without',
  'modification, are permitted provided that the following conditions are met:', '',
  '1. Redistributions of source code must retain the above copyright notice, this',
  '   list of conditions and the following disclaimer.', '',
  '2. Redistributions in binary form must reproduce the above copyright notice,',
  '   this list of conditions and the following disclaimer in the documentation',
  '   and/or other materials provided with the distribution.', '',
];
const BSD_NO_ENDORSEMENT = [
  '3. Neither the name of the copyright holder nor the names of its',
  '   contributors may be used to endorse or promote products derived from',
  '   this software without specific prior written permission.', '',
];
const BSD_DISCLAIMER = [
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
  'AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE',
  'IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE',
  'DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE',
  'FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL',
  'DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR',
  'SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER',
  'CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,',
  'OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE',
  'OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
];
const gnuHeader = name => [
  'Copyright (C) 2024  Acme Corp', '',
  'This program is free software: you can redistribute it and/or modify',
  `it under the terms of the GNU ${name} License as published by`,
  'the Free Software Foundation, either version 3 of the License, or',
  '(at your option) any later version.', '',
  'This program is distributed in the hope that it will be useful,',
  'but WITHOUT ANY WARRANTY; without even the implied warranty of',
  'MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the',
  `GNU ${name} License for more details.`, '',
  `You should have received a copy of the GNU ${name} License`,
  'along with this program.  If not, see <https://www.gnu.org/licenses/>.',
];
const LICENCE_HEADERS = {
  MIT: MIT_LICENCE,
  'Apache-2.0': APACHE_HEADER,
  'Apache-2.0 with an https link': APACHE_HEADER.map(l => l.replace('http:', 'https:')),
  'BSD-2-Clause': ['BSD 2-Clause License', '', 'Copyright (c) 2024, Acme Corp', '', ...BSD_CLAUSES, ...BSD_DISCLAIMER],
  'BSD-3-Clause': ['BSD 3-Clause License', '', 'Copyright (c) 2024, Acme Corp', '', ...BSD_CLAUSES, ...BSD_NO_ENDORSEMENT, ...BSD_DISCLAIMER],
  'GPL-3.0': gnuHeader('General Public'),
  'LGPL-3.0': gnuHeader('Lesser General Public'),
  'AGPL-3.0': gnuHeader('Affero General Public'),
  'MPL-2.0': MPL_HEADER,
};

for (const [name, lines] of Object.entries(LICENCE_HEADERS)) {
  test(`the full ${name} text is exempt as a #, // or /* */ header`, () => {
    for (const [file, text] of [['a.py', hashed(lines)], ['a.js', slashed(lines)], ['a.js', starred(lines)]]) {
      assert.deepEqual(countSource(file, `${text}\nx = 1;\n`), { comments: 0, suppressions: 0 }, text);
    }
  });
}

test('a TypeScript non-null assertion before a slash is division; a prefix ! still starts a regex', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.ts', 'const r = total! / count; // ratio\n', 1);
  at('a.ts', "const q = a! / b; const s = 'x'; // c\n", 1);
  at('a.ts', 'const r = f()! / 2; // c\n', 1);
  at('a.ts', 'const r = m[k]! / 2; // c\n', 1);
  at('a.ts', 'const r = a.b!.c! / 2; // c\n', 1);
  at('a.ts', 'const r = x!! / 2; // c\n', 1);
  at('a.ts', 'const r = a !== b ? x! / 2 : 1; // c\n', 1);
  at('a.ts', 'if (!/[//]/.test(x)) y(); // c\n', 1);
  at('a.ts', 'const t = !/[//]/.test(x); // c\n', 1);
  at('a.ts', 'const t = a && !/[//]/.test(x); // c\n', 1);
  at('a.ts', 'function f() { return !/[//]/.test(x); } // c\n', 1);
});

test('a sh heredoc delimiter is any word, quoted or not', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.sh', "cat <<'END-X'\n# no\nEND-X\n", 0);
  at('a.sh', 'cat <<"A.B"\n# no\nA.B\n# one\n', 1);
  at('a.sh', 'cat <<"A.B"\n# no\nAxB\n# still no\nA.B\n# one\n', 1);
  at('a.sh', 'cat <<END-X\n# no\nEND-X\n# one\n', 1);
  at('a.sh', 'cat <<END-X >out.txt\n# no\nEND-X\n# one\n', 1);
  at('a.sh', "\tcat <<-'a.b-c'\n\t# no\n\ta.b-c\n# one\n", 1);
  at('a.sh', 'cat <<\\END.X\n# no\nEND.X\n# one\n', 1);
  at('a.sh', 'cat <<END-X\necho hi\n# one\n', 1);
  at('a.sh', 'echo $((x << y))\n# one\n', 1);
});

test('a Rust suppression attribute counts only in code, not inside a string or a comment', () => {
  const at = (text, comments, suppressions) => assert.deepEqual(countSource('a.rs', text), { comments, suppressions }, text);
  at('let s = "\n#[allow(dead_code)]\n";\n', 0, 0);
  at('let s = r#"\n#[allow(dead_code)]\n"#;\n', 0, 0);
  at('let s = r##"\n#[expect(unused)]\n#[rustfmt::skip]\n"##;\n', 0, 0);
  at('let s = b"\n#[cfg_attr(test, allow(dead_code))]\n";\n', 0, 0);
  at('/*\n#[allow(dead_code)]\n*/\nfn f() {}\n', 3, 0);
  at('fn f() {}\n#[allow(dead_code)]\nfn g() {}\n', 0, 1);
  at('fn f(#[allow(unused)] x: i32) {}\n', 0, 1);
  at("let c = '#'; #[rustfmt::skip] let x = 1;\n", 0, 1);
});

test('a line comment right after a colon counts; only a // glued to the next character after a colon is a URL', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.js', 'switch (x) {\n  default:// real\n}\n', 1);
  at('a.js', 'const o = {a:// real\n 1};\n', 1);
  at('a.js', 'switch (x) {\n  case 1:// one\n  case b:// two\n}\n', 2);
  at('a.js', 'const y = a ? b:// real\n c;\n', 1);
  at('a.tsx', 'const L = () => <p>Docs: https://example.com</p>;\n', 0);
  at('a.jsx', 'const L = () => <a>see http://x.y/z and ftp://h</a>;\n', 0);
});

test('a JSX self-closing tag after an attribute brace is not a regex', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.tsx', 'const x = <Foo a={b} />; // real comment\n', 1);
  at('a.tsx', 'const x = <Foo a={b}/>; // real comment\n', 1);
  at('a.jsx', 'const x = <Foo {...p} />; // real comment\n', 1);
  at('a.jsx', 'const x = <Foo a={b} c={{ d: 1 }} />; // real comment\n', 1);
  at('a.js', 'const p = x.split(/>/); // c\n', 1);
  at('a.js', 'const p = x.split(/>\\/\\/ not/); // c\n', 1);
});

test('a quote glued to a word does not open a JS string, except after a keyword; a tagged template still does', () => {
  const at = (file, text, comments) => assert.deepEqual(countSource(file, text), { comments, suppressions: 0 }, text);
  at('a.jsx', "const e = <p>Don't</p>; // yes\n", 1);
  at('a.jsx', "const e = <p>It's 5 o'clock</p>; // yes\n", 1);
  at('a.tsx', "const e = <p>Students' work</p>; // yes\nconst f = 'x'; // two\n", 2);
  at('a.jsx', 'const e = <p>say"hi</p>; // yes\n', 1);
  at('a.js', 'const s = "it\'s // not";\nconst t = \'a\' + b; // c\n', 1);
  at('a.js', 'const s = tag`// not ${a}`; // c\nconst u = String.raw`/* not */`;\n', 1);
  at('a.js', 'import a from"b";// c\nimport"./c.css";// d\nfunction f(){return\'// not\'}// e\n', 3);
  at('a.js', 'switch(x){case"// not":break}// c\nif(typeof"x"in{});// d\n', 2);
});

const SUPPRESSION_FAMILIES = {
  'py nosec': [['a.py', 'run(x, shell=True)  # nosec\n'], ['a.py', 'assert x  # nosec B101\n']],
  'py coverage pragma': [['a.py', 'def f():  # pragma: no cover\n    pass\n'], ['a.py', 'if x:  # pragma: no branch\n    pass\n'], ['a.py', 'def g():  # pragma nocover\n    pass\n']],
  'py formatter and pylint file skips': [['a.py', 'x = [1,2]  # fmt: skip\n'], ['a.py', '# fmt: off\nx = 1\n'], ['a.py', '# isort: skip_file\n'], ['a.py', '# yapf: disable\n'], ['a.py', '# pylint: skip-file\n']],
  'css stylelint-disable': [['a.css', '/* stylelint-disable */\na { color: red; }\n'], ['a.css', '/* stylelint-disable-next-line color-named */\na { color: red; }\n'], ['a.css', 'a { color: red; } /* stylelint-disable-line */\n']],
  'js eslint inline rule off': [['a.js', '/* eslint no-console: off */\n'], ['a.js', '/* eslint no-console: "off" */\n'], ['a.js', '/* eslint no-console: 0 */\n'], ['a.js', "/* eslint quotes: ['off'] */\n"], ['a.js', '/* eslint semi: 2, no-console: off */\n']],
  'js biome-ignore': [['a.js', '// biome-ignore lint: x\ndebugger;\n'], ['a.js', '// biome-ignore lint/suspicious/noDebugger: x\ndebugger;\n'], ['a.js', '// biome-ignore-all lint: generated\n'], ['a.js', '// biome-ignore format: aligned\n']],
  'js coverage ignore': [['a.js', '/* istanbul ignore next */\n'], ['a.js', '/* istanbul ignore else */\n'], ['a.js', '/* c8 ignore next */\n'], ['a.js', '/* c8 ignore start */\n'], ['a.js', '/* v8 ignore next */\n'], ['a.js', '/* node:coverage ignore next */\n'], ['a.js', '/* node:coverage disable */\n']],
  'prettier-ignore': [['a.js', '// prettier-ignore\nconst m = [1,0,\n  0,1];\n'], ['a.css', '/* prettier-ignore */\n.a {}\n'], ['a.html', '<!-- prettier-ignore -->\n<p></p>\n'], ['a.yml', '# prettier-ignore\na: 1\n']],
  'other js linter ignores': [['a.js', '// oxlint-disable-next-line no-debugger\n'], ['a.ts', '// deno-lint-ignore no-explicit-any\n'], ['a.ts', '// deno-lint-ignore-file\n']],
  'rs expect, cfg_attr allow and rustfmt skip': [['a.rs', '#[expect(dead_code)]\nfn f() {}\n'], ['a.rs', '#![expect(unused)]\n'], ['a.rs', '#[cfg_attr(test, allow(dead_code))]\nfn f() {}\n'], ['a.rs', '#[cfg_attr(feature = "x", expect(unused))]\n'], ['a.rs', '#[rustfmt::skip]\nfn f() {}\n']],
};

for (const [family, cases] of Object.entries(SUPPRESSION_FAMILIES)) {
  test(`${family} is a suppression`, () => {
    for (const [file, text] of cases) assert.deepEqual(countSource(file, text), { comments: 0, suppressions: 1 }, text);
  });
}

const FUNCTIONAL_DIRECTIVES = {
  'js sourceMappingURL': [['a.js', 'x();\n//# sourceMappingURL=a.js.map\n'], ['a.js', 'x();\n//@ sourceMappingURL=a.js.map\n'], ['a.js', 'x();\n//# sourceURL=a.js\n']],
  'css sourceMappingURL': [['a.css', 'a {}\n/*# sourceMappingURL=a.css.map */\n']],
  'js global and exported block comments': [['a.js', '/* global foo */\n'], ['a.js', '/* globals foo, bar: writable */\n'], ['a.js', '/*global foo*/\n'], ['a.js', '/* exported foo */\n']],
  'js eslint rule config that is not off': [['a.js', '/* eslint quotes: ["error", "double"] */\n'], ['a.js', '/* eslint no-console: 2 */\n']],
  'js jsx pragmas': [['a.jsx', '/** @jsx h */\n'], ['a.jsx', '/** @jsxImportSource preact */\n'], ['a.jsx', '// @jsxRuntime classic\n']],
  'js bundler annotations': [['a.js', 'const a = /*#__PURE__*/ f();\n'], ['a.js', 'const a = /* @__PURE__ */ f();\n'], ['a.js', "import(/* webpackChunkName: \"a\" */ './a');\n"]],
  'sh shellcheck settings': [['a.sh', '# shellcheck enable=require-variable-braces\n'], ['a.sh', '# shellcheck source-path=SCRIPTDIR\n']],
  'the end of a suppressed region': [['a.js', '/* eslint-enable */\n'], ['a.css', '/* stylelint-enable */\n'], ['a.js', '/* c8 ignore stop */\n'], ['a.js', '/* node:coverage enable */\n'], ['a.py', '# fmt: on\n'], ['a.py', '# pylint: enable=invalid-name\n'], ['a.yml', '# yamllint enable\n']],
};

for (const [family, cases] of Object.entries(FUNCTIONAL_DIRECTIVES)) {
  test(`${family} is an exempt directive`, () => {
    for (const [file, text] of cases) assert.deepEqual(countSource(file, text), { comments: 0, suppressions: 0 }, text);
  });
}

test('directive words in prose or in a line comment still count as comments', () => {
  const cases = [
    ['a.js', '// global state is shared\n'], ['a.js', '// exported for tests\n'], ['a.js', '/* globalThis is used */\n'],
    ['a.py', '# nosecurity review yet\n'], ['a.js', '// prettier ignores this file elsewhere\n'], ['a.js', '/* eslint is configured in the root */\n'],
  ];
  for (const [file, text] of cases) assert.deepEqual(countSource(file, text), { comments: 1, suppressions: 0 }, text);
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
