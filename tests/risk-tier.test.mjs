import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, riskTier } from '../plugins/bstack/scripts/risk-tier.mjs';

const file = (p, { add = [], del = [], created = false, deleted = false } = {}) =>
  [`diff --git a/${p} b/${p}`, created ? 'new file mode 100644' : '', deleted ? 'deleted file mode 100644' : '', `--- a/${p}`, `+++ b/${p}`,
    ...del.map(l => `-${l}`), ...add.map(l => `+${l}`)].filter(Boolean).join('\n');
const addedAsHead = diff => p => parseDiff(diff).find(f => f.path === p)?.added.join('\n') ?? null;
const tier = (...files) => { const diff = files.join('\n'); return riskTier(diff, { readFile: addedAsHead(diff) }).tier; };

test('docs only is tier 0', () => {
  assert.equal(tier(file('README.md', { add: ['words'] }), file('docs/setup.md', { add: ['more'] })), 0);
});

test('agent instructions, requirements and the language allowlist are not docs', () => {
  assert.equal(tier(file('AGENTS.md', { add: ['rule'] })), 1);
  assert.equal(tier(file('requirements.txt', { add: ['httpx'] })), 1);
  assert.equal(tier(file('.github/danish-allowed.txt', { add: ['app/*.py'] })), 1);
});

test('ordinary code and config are tier 1', () => {
  assert.equal(tier(file('app/main.py', { add: ['x = 1'] })), 1);
  assert.equal(tier(file('.github/workflows/ci.yml', { add: ['      - run: pytest -q'] })), 1);
  assert.equal(tier(file('app/routes.py', { add: ['@app.post("/items")'] })), 1);
});

test('data, schema and side effects are tier 2', () => {
  assert.equal(tier(file('app/schema.sql', { add: ['CREATE TABLE t (id int);'] })), 2);
  assert.equal(tier(file('app/db.py', { add: ['conn.execute("DELETE FROM orders WHERE id = ?")'] })), 2);
  assert.equal(tier(file('app/db.py', { add: ['conn.execute("INSERT INTO rows VALUES (?)")'] })), 2);
  assert.equal(tier(file('app/notify.py', { add: ['httpx.post(url, json=payload)'] })), 2);
  assert.equal(tier(file('crates/web/src/publish.rs', { add: ['let r = client.post(url).send().await?;'] })), 2);
  assert.equal(tier(file('app/importer.py', { add: ['rows = parse(f)'] })), 2);
  assert.equal(tier(file('app/auth.py', { add: ['return True'] })), 2);
  assert.equal(tier(file('n8n/build-requests.js', { add: ['const x = 1;'] })), 2);
});

test('comments mentioning risky words stay tier 1', () => {
  assert.equal(tier(file('app/main.py', { add: ['# we never DELETE FROM here'] })), 1);
});

test('weakened checks are tier 2', () => {
  assert.equal(tier(file('tests/test_api.py', { add: ['@pytest.mark.skip("flaky")'] })), 2);
  assert.equal(tier(file('tests/test_api.py', { deleted: true, del: ['def test_a():', '    assert a()'] })), 2);
  assert.equal(tier(file('tests/test_api.py', { del: ['def test_b():', '    assert b()'] })), 2);
  assert.equal(tier(file('tests/test_api.py', { del: ['    assert x == 1'], add: ['    x'] })), 2);
  assert.equal(tier(file('app/main.py', { add: ['import os  # noqa: F401'] })), 2);
  assert.equal(tier(file('.github/workflows/ci.yml', { del: ['      - run: pyright'] })), 2);
  assert.equal(tier(file('.github/workflows/ci.yml', { add: ['        continue-on-error: true'] })), 2);
});

test('markdown that names a suppression token is not a suppression', () => {
  assert.equal(tier(file('plugins/bstack/agents/comment-critic.md', { add: ['Look for `eslint-disable`, `# noqa` and `@ts-ignore`.'] })), 1);
  assert.equal(tier(file('docs/guide.md', { add: ['Never add `type: ignore`.'] })), 0);
});

test('markdown that names a test skip or an allowed failure is not a weakened check', () => {
  assert.equal(tier(file('plugins/bstack/agents/reviewer.md', { add: ['Flag a new `it.skip(` or `|| true`.'] })), 1);
  assert.equal(tier(file('docs/ci.md', { add: ['Never add `continue-on-error: true` or `@pytest.mark.skip`.'] })), 0);
});

test('a test skip or an allowed failure outside prose is tier 2', () => {
  assert.equal(tier(file('tests/api.test.mjs', { add: ["it.skip('flaky', () => {});"] })), 2);
  assert.equal(tier(file('.github/workflows/ci.yml', { add: ['      - run: npm test || true'] })), 2);
  assert.equal(tier(file('.github/workflows/ci.yml', { add: ['        continue-on-error: true'] })), 2);
  assert.equal(tier(file('package.json', { add: ['    "test": "node --test || true",'] })), 2);
  assert.equal(tier(file('scripts/check.sh', { add: ['pyright || true'] })), 2);
});

test('an allowed failure in a CMakeLists.txt is tier 2', () => {
  const line = 'add_custom_target(check COMMAND sh -c "ctest || true")';
  assert.equal(tier(file('CMakeLists.txt', { add: [line] })), 2);
  assert.equal(tier(file('src/CMakeLists.txt', { add: [line] })), 2);
});

test('an allowed failure in a command file that Claude Code executes is tier 2', () => {
  assert.equal(tier(file('.claude/commands/test.md', { add: ['!`npm test || true`'] })), 2);
  assert.equal(tier(file('plugins/x/commands/check.md', { add: ['!`node --test || true`'] })), 2);
  assert.equal(tier(file('plugins/x/commands/check.md', { add: ['Run `npm test || true` and report.'] })), 2);
});

test('an allowed failure in an executed line of a markdown file is tier 2', () => {
  assert.equal(tier(file('plugins/bstack/skills/x/SKILL.md', { add: ['!`npm test || true`'] })), 2);
  assert.equal(tier(file('docs/x.md', { add: ['Run it: !`node --test || true`'] })), 2);
  assert.equal(tier(file('plugins/bstack/agents/x.md', { add: ['!`echo ok` then flag a new `|| true`.'] })), 2);
});

test('an allowed failure in a fenced block that Claude Code executes is tier 2', () => {
  assert.equal(tier(file('plugins/bstack/skills/x/SKILL.md', { add: ['```!', 'npm test || true', '```'] })), 2);
  assert.equal(tier(file('docs/x.md', { add: ['```!', 'node --test || true', '```'] })), 2);
  assert.equal(tier(file('docs/x.md', { add: ['```! npm test || true```'] })), 2);
});

test('a fenced block that is not executed, or executes nothing weakened, keeps its tier', () => {
  assert.equal(tier(file('plugins/bstack/skills/x/SKILL.md', { add: ['```!', 'npm test', '```'] })), 1);
  assert.equal(tier(file('docs/x.md', { add: ['```bash', 'npm test || true', '```'] })), 0);
});

test('an edit inside an executed block whose fence is outside the diff is tier 2', () => {
  const head = ['# Check', '', '```!', 'npm ci', 'npm test || true', '```', '', 'Never write `|| true` yourself.'].join('\n');
  const diff = ['diff --git a/plugins/bstack/skills/x/SKILL.md b/plugins/bstack/skills/x/SKILL.md', '--- a/plugins/bstack/skills/x/SKILL.md',
    '+++ b/plugins/bstack/skills/x/SKILL.md', '@@ -5 +5 @@', '-npm test', '+npm test || true'].join('\n');
  assert.equal(riskTier(diff, { readFile: () => head }).tier, 2);
  assert.equal(riskTier(diff, { readFile: () => head.replace(/\n/g, '\r\n') }).tier, 2);
  const prose = diff.replace('+npm test || true', '+Never write `|| true` yourself.');
  assert.equal(riskTier(prose, { readFile: () => head }).tier, 1);
});

test('an allowed failure in a frontmatter hook of a skill or agent file is tier 2', () => {
  const hook = '          command: "npm test || true"';
  const named = 'Never write `|| true` yourself.';
  const head = ['---', 'name: x', 'description: y', 'hooks:', '  PostToolUse:', '    - matcher: "Edit|Write"', '      hooks:', '        - type: command',
    hook, '---', '', '# X', '', named].join('\n');
  const edit = (p, line) => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  for (const p of ['plugins/bstack/skills/x/SKILL.md', '.claude/agents/a.md', 'plugins/bstack/agents/a.md']) {
    assert.equal(riskTier(edit(p, hook), { readFile: () => head }).tier, 2, p);
    assert.equal(riskTier(edit(p, hook), { readFile: () => `﻿${head.replace(/\n/g, '\r\n')}` }).tier, 2, p);
    assert.equal(riskTier(edit(p, named), { readFile: () => head }).tier, 1, p);
  }
});

test('an executed block after frontmatter that names an executed form is tier 2', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  const named = 'Never write `|| true` yourself.';
  const edit = line => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  const fence = ['---', 'name: x', 'description: Explains the ```! block form', '---', '', '```!', 'npm test || true', '```', '', named].join('\n');
  const inline = ['---', 'name: x', 'description: Lines that start with !` run', '---', '', 'Run !`npm test || true` first.', '', named].join('\n');
  assert.equal(riskTier(edit('npm test || true'), { readFile: () => fence }).tier, 2);
  assert.equal(riskTier(edit('Run !`npm test || true` first.'), { readFile: () => inline }).tier, 2);
  assert.equal(riskTier(edit(named), { readFile: () => fence }).tier, 1);
  assert.equal(riskTier(edit(named), { readFile: () => inline }).tier, 1);
});

test('frontmatter whose opening or closing dashes have trailing whitespace is executed', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  const hook = '          command: npm test || true';
  const named = 'Never write `|| true` yourself.';
  const edit = line => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  const head = (open, close) => [open, 'name: x', 'hooks:', '  Stop:', '    - hooks:', '        - type: command', hook, close, '', named].join('\n');
  for (const [open, close] of [['--- ', '---'], ['---', '--- ']]) {
    assert.equal(riskTier(edit(hook), { readFile: () => head(open, close) }).tier, 2, JSON.stringify([open, close]));
    assert.equal(riskTier(edit(named), { readFile: () => head(open, close) }).tier, 1, JSON.stringify([open, close]));
  }
  const rule = ['# X', '', 'Intro.', '', '---', '', named].join('\n');
  assert.equal(riskTier(edit(named), { readFile: () => rule }).tier, 1);
});

test('an inline command after a code span that ends in ! is executed', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  const edit = line => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  const sameLine = 'Type `cd !` then !`npm test || true`.';
  const nextLine = 'then run !`npm test || true` now.';
  const twoLines = ['---', 'name: x', 'description: y', '---', 'Type `cd !` first,', nextLine].join('\n');
  assert.equal(riskTier(edit(sameLine), { readFile: () => sameLine }).tier, 2);
  assert.equal(riskTier(edit(nextLine), { readFile: () => twoLines }).tier, 2);
  const named = 'Type `cd !` then never write `|| true` yourself.';
  assert.equal(riskTier(edit(named), { readFile: () => named }).tier, 2);
});

test('an inline command right after an argument placeholder is executed', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  for (const line of ['$ARGUMENTS!`npm test || true`', '$name!`npm test || true`']) {
    const head = ['---', 'name: x', 'description: y', '---', 'Run the suite:', line, ''].join('\n');
    const edit = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
    assert.equal(riskTier(edit, { readFile: () => head }).tier, 2, line);
  }
});

test('an empty argument placeholder between ! and the backtick still makes an inline command', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  const edit = line => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  for (const line of ['Run !$ARGUMENTS`npm test || true` first.', 'Run !$target`npm test || true`', 'Run !$1`npm test || true`', 'Run !${x}$ARGUMENTS[0]`npm test || true`', 'Run !$issue-number`npm test || true`', 'Run !$file.path`npm test || true`', 'Run !$navn_ø`npm test || true`']) {
    assert.equal(riskTier(edit(line), { readFile: () => `Intro\n${line}\n` }).tier, 2, line);
  }
  const head = ['Run !$ARGUMENTS`', 'npm test || true`', '', 'Cost: $5 and `|| true` in prose.'].join('\n');
  assert.equal(riskTier(edit('npm test || true`'), { readFile: () => head }).tier, 2);
  assert.equal(riskTier(edit('Cost: $5 and `|| true` in prose.'), { readFile: () => head }).tier, 1);
});

test('an inline command that continues on the next line is executed there too', () => {
  const p = 'plugins/bstack/skills/x/SKILL.md';
  const edit = line => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, `+${line}`].join('\n');
  const head = ['Run !`npm test', '|| true` now.', '', 'Never write `|| true` yourself.'].join('\n');
  assert.equal(riskTier(edit('|| true` now.'), { readFile: () => head }).tier, 2);
  assert.equal(riskTier(edit('Never write `|| true` yourself.'), { readFile: () => head }).tier, 1);
});

test('a prose file whose head cannot be read keeps the weakening rules', () => {
  const diff = file('docs/ci.md', { add: ['Never add `|| true`.'] });
  assert.equal(riskTier(diff).tier, 2);
  assert.equal(riskTier(diff, { readFile: () => null }).tier, 2);
  assert.equal(riskTier(diff, { readFile: () => { throw new Error('404'); } }).tier, 2);
  assert.equal(riskTier(diff, { readFile: () => 'another text' }).tier, 2);
});

test('the head of a prose file is read only when an added line matches a weakening rule', () => {
  const read = [];
  const readFile = p => { read.push(p); return 'Never add `|| true`.'; };
  riskTier([file('docs/a.md', { add: ['words'] }), file('app/main.py', { add: ['x = 1 || true'] }), file('docs/ci.md', { add: ['Never add `|| true`.'] })].join('\n'), { readFile });
  assert.deepEqual(read, ['docs/ci.md']);
});

test('a commands directory at the root of a single-plugin repo is executed, not docs', () => {
  assert.equal(tier(file('commands/check.md', { add: ['!`npm test || true`'] })), 2);
  assert.equal(tier(file('commands/check.md', { add: ['Run the tests.'] })), 1);
});

test('a command file is not docs', () => {
  assert.equal(tier(file('.claude/commands/x.md', { add: ['Run the tests.'] })), 1);
  assert.equal(tier(file('plugins/x/commands/x.md', { add: ['Run the tests.'] })), 1);
});

test('prose in non-source files that names a suppression token is not a suppression', () => {
  assert.equal(tier(file('docs/guide.rst', { add: ['Never add ``type: ignore``.'] })), 0);
  assert.equal(tier(file('plugins/bstack/skills/x/notes.txt', { add: ['Never add `# noqa`.'] })), 1);
  assert.equal(tier(file('docs/guide.adoc', { add: ['Never add `# noqa`.'] })), 0);
});

test('a suppression in a source file outside the CODE extensions is tier 2', () => {
  assert.equal(tier(file('src/util.mts', { add: ['// @ts-ignore'] })), 2);
  assert.equal(tier(file('src/util.cts', { add: ['// @ts-ignore'] })), 2);
  assert.equal(tier(file('src/page.mdx', { add: ['{/* eslint-disable */}'] })), 2);
  assert.equal(tier(file('notebooks/a.ipynb', { add: ['    "import os  # noqa\\n",'] })), 2);
  assert.equal(tier(file('src/app.pyw', { add: ['x = f()  # type: ignore'] })), 2);
  assert.equal(tier(file('bin/tool', { add: ['x = f()  # type: ignore'] })), 2);
});

test('a suppression in a source file is tier 2', () => {
  assert.equal(tier(file('src/app.js', { add: ['// eslint-disable-next-line no-console'] })), 2);
  assert.equal(tier(file('src/app.py', { add: ['x = f()  # noqa: E501'] })), 2);
  assert.equal(tier(file('src/app.ts', { add: ['// @ts-expect-error legacy'] })), 2);
  assert.equal(tier(file('src/lib.rs', { add: ['#[allow(dead_code)]'] })), 2);
});

test('suppression tokens in fixture files are not suppressions', () => {
  assert.equal(tier(file('tests/fixtures/comments/sample.js', { created: true, add: ['// eslint-disable-next-line no-console'] })), 1);
  assert.equal(tier(file('fixtures/a.py', { add: ['import os  # noqa: F401'] })), 1);
  assert.equal(tier(file('src/__fixtures__/a.ts', { add: ['// @ts-ignore'] })), 1);
  assert.equal(tier(file('pkg/testdata/a.rs', { add: ['#[allow(dead_code)]'] })), 1);
});

test('suppression tokens in test files are not suppressions', () => {
  assert.equal(tier(file('tests/x.test.mjs', { add: ["  assert.equal(tier(file('src/app.js', { add: ['// eslint-disable-next-line'] })), 2);"] })), 1);
  assert.equal(tier(file('tests/fixtures/comments/sample.ts', { add: ['// @ts-ignore'] })), 1);
  assert.equal(tier(file('test/test_scan.py', { add: ['    assert count("x = 1  # noqa") == 1'] })), 1);
  assert.equal(tier(file('src/__tests__/a.js', { add: ['// eslint-disable-line'] })), 1);
  assert.equal(tier(file('src/a.test.ts', { add: ['// @ts-expect-error'] })), 1);
  assert.equal(tier(file('pkg/scan_test.rs', { add: ['#[allow(dead_code)]'] })), 1);
});

test('a suppression token in a string in non-test source is tier 2, the accepted cost of not parsing literals', () => {
  assert.equal(tier(file('src/a.js', { add: ['const s = "eslint-disable";'] })), 2);
  assert.equal(tier(file('src/scan.mjs', { add: ['const RE = /eslint-disable|@ts-ignore/;'] })), 2);
  assert.equal(tier(file('src/a.py', { add: ['x = "# noqa"'] })), 2);
});

test('a data-only .sql test fixture is tier 1, created or modified', () => {
  assert.equal(tier(file('tests/fixtures/comments/sample.sql', { created: true, add: ['-- count rows', 'SELECT id, name', 'FROM t;'] })), 1);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ["INSERT INTO t (id, name) VALUES (1, 'a');", 'DELETE FROM t WHERE id = 2;'] })), 1);
  assert.equal(tier(file('tests/fixtures/db/q.sql', { add: ['SELECT a,', '  b', 'FROM t;'], del: ['SELECT a FROM t;'] })), 1);
  assert.equal(tier(file('pkg/test/testdata/seed.sql', { created: true, add: ['SELECT 1;'] })), 1);
});

test('a schema statement in a .sql test fixture is tier 2', () => {
  for (const s of ['CREATE TABLE t (id int);', 'DROP TABLE t;', 'ALTER TABLE t ADD COLUMN x int;']) {
    assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: [s] })), 2, s);
    assert.equal(tier(file('tests/fixtures/db/seed.sql', { add: ['SELECT 1;', s] })), 2, s);
    assert.equal(tier(file('tests/fixtures/db/seed.sql', { del: [s] })), 2, s);
  }
  assert.deepEqual(riskTier(file('tests/fixtures/db/seed.sql', { add: ['DROP TABLE t;'] })).reasons,
    ['SQL schema statement: tests/fixtures/db/seed.sql']);
});

test('a .sql test fixture whose diff shows no lines keeps the path rule', () => {
  const binary = ['diff --git a/tests/fixtures/db/seed.sql b/tests/fixtures/db/seed.sql', 'new file mode 100644',
    'index 0000000..1234567', 'Binary files /dev/null and b/tests/fixtures/db/seed.sql differ'].join('\n');
  assert.equal(tier(binary), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true })), 2);
});

test('a .sql file outside a test fixture keeps the path rule', () => {
  assert.equal(tier(file('db/migrations/001_init.sql', { add: ['SELECT 1;'] })), 2);
  assert.equal(tier(file('app/queries.sql', { add: ['SELECT 1;'] })), 2);
  assert.equal(tier(file('fixtures/seed.sql', { created: true, add: ['SELECT 1;'] })), 2);
  assert.equal(tier(file('tests/seed.sql', { created: true, add: ['SELECT 1;'] })), 2);
});

const renamed = (from, to, lines, { headers = false } = {}) =>
  [`diff --git a/${from} b/${to}`, ...(headers ? ['similarity index 95%', `rename from ${from}`, `rename to ${to}`] : []),
    `--- a/${from}`, `+++ b/${to}`, '@@ -18,3 +18,4 @@', ...lines].join('\n');

test('a schema file renamed into a test fixture dir keeps tier 2', () => {
  for (const headers of [false, true]) {
    const migration = riskTier(renamed('migrations/0005_users.sql', 'tests/fixtures/0005_users.sql',
      [' CREATE TABLE t18 (id int);', '+-- fixture copy'], { headers }));
    assert.equal(migration.tier, 2, `migration, headers=${headers}`);
    assert.ok(migration.reasons.includes('schema or migration file: migrations/0005_users.sql'), migration.reasons.join());
    assert.equal(tier(renamed('db/schema.sql', 'tests/fixtures/schema.sql', ["+INSERT INTO t VALUES (1);"], { headers })), 2, `schema, headers=${headers}`);
  }
});

test('a rename within test fixtures keeps the fixture exemptions', () => {
  for (const headers of [false, true]) {
    assert.equal(tier(renamed('tests/fixtures/a/seed.sql', 'tests/fixtures/b/seed.sql', ["+INSERT INTO t VALUES (1);"], { headers })), 1);
    assert.equal(tier(renamed('tests/fixtures/a.js', 'tests/fixtures/b.js', ['+// eslint-disable-next-line'], { headers })), 1);
  }
});

test('a source file renamed into a test dir loses no suppression check', () => {
  assert.equal(tier(renamed('src/a.js', 'tests/fixtures/a.js', ['+// eslint-disable-next-line'], { headers: true })), 2);
});

test('a runnable test renamed out of the suite is tier 2', () => {
  for (const headers of [false, true]) {
    for (const [from, to] of [['tests/x.test.mjs', 'tests/x.test.md'], ['tests/test_api.py', 'scripts/api_check.py'], ['src/a.test.ts', 'src/a.test.ts.bak']]) {
      for (const lines of [[], [' x', '+y']]) {
        const r = riskTier(renamed(from, to, lines, { headers }));
        assert.equal(r.tier, 2, `${from} -> ${to}, headers=${headers}, edited=${lines.length > 0}`);
        assert.ok(r.reasons.includes(`test file renamed out of the suite: ${from} -> ${to}`), r.reasons.join());
      }
    }
  }
});

test('a test renamed between runnable test paths is not tier 2 by itself', () => {
  for (const headers of [false, true]) {
    assert.equal(tier(renamed('tests/a.test.mjs', 'tests/b.test.mjs', [], { headers })), 1);
    assert.equal(tier(renamed('tests/a.test.mjs', 'tests/b.test.mjs', [' x', "+const y = 'z';"], { headers })), 1);
  }
});

const quoted = (a, b, lines) => [`diff --git ${a} ${b}`, `--- ${a}`, `+++ ${b}`, '@@ -1 +1,2 @@', ...lines].join('\n');

test('a quoted path with a space is parsed with its real path', () => {
  const [f] = parseDiff(quoted('"a/docs/my guide.md"', '"b/docs/my guide.md"', ['+words']));
  assert.equal(f?.path, 'docs/my guide.md');
  assert.equal(f.oldPath, null);
  assert.equal(parseDiff('diff --git a/docs/my guide.md b/docs/my guide.md\n+words')[0]?.path, 'docs/my guide.md');
});

test('an octal-escaped non-ASCII path is decoded', () => {
  const [f] = parseDiff(quoted('"a/docs/s\\303\\246t \\"x\\".md"', '"b/docs/s\\303\\246t \\"x\\".md"', ['+words']));
  assert.equal(f?.path, 'docs/sæt "x".md');
  const [r] = parseDiff(quoted('a/old.py', '"b/n\\303\\246w.py"', ['+x = 1']));
  assert.deepEqual([r?.path, r?.oldPath], ['næw.py', 'old.py']);
});

test('risky code under a quoted path raises the tier', () => {
  assert.equal(tier(quoted('"a/app/my db.py"', '"b/app/my db.py"', ['+conn.execute("DELETE FROM orders WHERE id = ?")'])), 2);
});

test('adding tests stays tier 1', () => {
  assert.equal(tier(file('tests/test_api.py', { created: true, add: ['def test_c():', '    assert c()'] })), 1);
});

test('risk-paths.txt raises listed paths', () => {
  const diff = file('app/billing/calc.py', { add: ['x = 2'] });
  assert.equal(riskTier(diff).tier, 1);
  assert.equal(riskTier(diff, { extraPaths: ['app/billing/**'] }).tier, 2);
});

test('reasons name the file', () => {
  const r = riskTier(file('app/schema.sql', { add: ['ALTER TABLE t ADD COLUMN c int;'] }));
  assert.ok(r.reasons.some(x => x.includes('app/schema.sql')));
});
