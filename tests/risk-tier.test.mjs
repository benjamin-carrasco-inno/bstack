import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskTier } from '../plugins/bstack/scripts/risk-tier.mjs';

const file = (p, { add = [], del = [], created = false, deleted = false } = {}) =>
  [`diff --git a/${p} b/${p}`, created ? 'new file mode 100644' : '', deleted ? 'deleted file mode 100644' : '', `--- a/${p}`, `+++ b/${p}`,
    ...del.map(l => `-${l}`), ...add.map(l => `+${l}`)].filter(Boolean).join('\n');
const tier = (...files) => riskTier(files.join('\n')).tier;

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

test('suppression tokens inside string or regex literals are not suppressions', () => {
  assert.equal(tier(file('tests/risk.test.mjs', { add: ["  assert.equal(tier(file('src/app.js', { add: ['// eslint-disable-next-line no-console'] })), 2);"] })), 1);
  assert.equal(tier(file('src/scan.mjs', { add: ['const RE = /eslint-disable|@ts-ignore/;'] })), 1);
  assert.equal(tier(file('tests/test_scan.py', { add: ['    assert count("x = 1  # noqa") == 1'] })), 1);
  assert.equal(tier(file('src/a.rs', { add: ['let s = "#[allow(dead_code)]";'] })), 1);
});

test('real suppressions in comments stay tier 2 next to literals', () => {
  assert.equal(tier(file('src/a.js', { add: ['// eslint-disable-next-line'] })), 2);
  assert.equal(tier(file('src/a.py', { add: ['x = f()  # noqa'] })), 2);
  assert.equal(tier(file('src/a.js', { add: ['const s = "x"; // eslint-disable-line'] })), 2);
  assert.equal(tier(file('src/a.js', { add: ['const s = "eslint-disable"; // eslint-disable-line'] })), 2);
  assert.equal(tier(file('src/a.js', { add: [' * eslint-disable no-console'] })), 2);
  assert.equal(tier(file('src/a.js', { add: ['eslint-disable no-console'] })), 2);
  assert.equal(tier(file('src/a.ts', { add: ['const s = `', '// @ts-ignore'] })), 2);
});

test('a data-only .sql fixture is not a schema file', () => {
  assert.equal(tier(file('tests/fixtures/comments/sample.sql', { created: true, add: ['-- count rows', 'SELECT id, name', 'FROM t;'] })), 1);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { add: ['CREATE TABLE t (id int);'] })), 2);
  assert.equal(tier(file('db/migrations/001_init.sql', { add: ['SELECT 1;'] })), 2);
  assert.equal(tier(file('app/queries.sql', { add: ['SELECT 1;'] })), 2);
});

test('a suppression on a line with a template or triple-quote delimiter always counts', () => {
  assert.equal(tier(file('src/a.js', { add: ['abc`; foo(); // eslint-disable-line'] })), 2);
  assert.equal(tier(file('src/a.ts', { add: ['`; const n: number = "x"; // @ts-ignore'] })), 2);
  assert.equal(tier(file('src/a.ts', { add: ['  ${x}`); // @ts-expect-error'] })), 2);
  assert.equal(tier(file('src/a.js', { add: ['abc`; foo(); // eslint-disable-line `'] })), 2);
  assert.equal(tier(file('src/a.py', { add: ['end"""; x = f()  # noqa'] })), 2);
  assert.equal(tier(file('src/a.py', { add: ["end'''; x = f()  # noqa '''"] })), 2);
});

test('a .sql fixture with any schema statement or unrecognised line is a schema file', () => {
  const statements = [
    'CREATE UNIQUE INDEX i ON t (id);', 'CREATE SCHEMA s;', 'CREATE OR REPLACE VIEW v AS SELECT 1;',
    'CREATE MATERIALIZED VIEW v AS SELECT 1;', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
    "CREATE TYPE mood AS ENUM ('a');", 'CREATE SEQUENCE s;', 'CREATE TEMP TABLE t (id int);', 'DROP SCHEMA s;',
    'CREATE EXTENSION pgcrypto;', "ALTER TYPE mood ADD VALUE 'b';", 'GRANT SELECT ON t TO r;', 'REVOKE SELECT ON t FROM r;',
    'TRUNCATE t;', "COMMENT ON TABLE t IS 'x';", 'SELECT 1; CREATE TABLE t (id int);',
  ];
  for (const s of statements) assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: [s] })), 2, s);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ['CREATE', 'TABLE t (id int);'] })), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ['SELECT 1;', '  extra int,'] })), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ['VACUUM;'] })), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ['SELECT 1', '\\i schema.sql'] })), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { deleted: true, del: ['CREATE TABLE t (id int);'] })), 2);
  assert.equal(tier(file('pkg/testdata/seed.sql', { deleted: true, del: ['SELECT 1;'] })), 1);
});

test('a .sql fixture of queries and inserts is data', () => {
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: [
    '-- seed rows', '', 'INSERT INTO t (id, name) VALUES', "  (1, 'a'),", "  (2, 'b');",
    'WITH r AS (SELECT id FROM t)', 'SELECT t.id', 'FROM t', '  JOIN r ON r.id = t.id', 'WHERE t.id > 0',
    '  AND t.name IS NOT NULL', 'ORDER BY t.id', 'LIMIT 10;', "UPDATE t SET name = 'c' WHERE id = 1;", 'DELETE FROM t WHERE id = 2;',
  ] })), 1);
  assert.equal(tier(file('tests/fixtures/comments/sample.sql', { created: true, add: [
    '-- Report query.', 'SELECT id, -- trailing', "       'it''s -- not a comment' AS quote,", '       "weird--name"',
    'FROM items', '/* multi', '   line */', "WHERE note <> '/* not */';",
  ] })), 1);
});

test('a modified .sql fixture is a schema file, since the diff hides the statement around its lines', () => {
  const sql = lines => ['diff --git a/tests/fixtures/db/q.sql b/tests/fixtures/db/q.sql', '--- a/tests/fixtures/db/q.sql',
    '+++ b/tests/fixtures/db/q.sql', ...lines].join('\n');
  assert.equal(tier(file('tests/fixtures/db/schema.sql', { add: ['  extra int,'] })), 2);
  assert.equal(tier(sql(['@@ -1,2 +1,3 @@', ' CREATE TABLE t (', '+  extra int,'])), 2);
  assert.equal(tier(sql(['@@ -1,2 +1,3 @@', ' CREATE VIEW v AS', '+SELECT a, b FROM t;'])), 2);
  assert.equal(tier(sql(['@@ -1,2 +1,3 @@', ' CREATE INDEX i ON t', '+(a, b);'])), 2);
  assert.equal(tier(sql(['@@ -1,2 +1,3 @@', '+SELECT a,', '+  b', '+FROM t;'])), 2);
});

test('an unterminated literal on a line exempts no suppression on that line', () => {
  const cases = [
    ['src/About.tsx', "      <p>Back in the '90s we shipped weekly</p> {/* eslint-disable-line react/no-unescaped-entities */}"],
    ['src/Band.jsx', "  <li>Rock 'n roll</li> {/* eslint-disable-line react/no-unescaped-entities */}"],
    ['src/A.tsx', "  <Foo label='x' /> 'quote <Bar prop={1} /> {/* @ts-expect-error */}"],
    ['src/a.py', '  tail of string"; x = f()  # type: ignore'],
    ['src/a.js', "  tail of string '; foo(); // @ts-ignore"],
  ];
  for (const [p, l] of cases) assert.equal(tier(file(p, { add: [l] })), 2, l);
  assert.equal(tier(file('src/a.js', { add: ['const s = "eslint-disable";'] })), 1);
  assert.equal(tier(file('src/a.py', { add: ['x = "# noqa"'] })), 1);
});

test('a .sql fixture that copies rows or touches the catalog is a schema file', () => {
  const fixtures = [
    ['SELECT * INTO users_backup FROM users;'],
    ['SELECT *', 'INTO users_backup', 'FROM users;'],
    ["UPDATE pg_catalog.pg_attribute SET attnotnull = false WHERE attname = 'id';"],
    ['SELECT * FROM information_schema.tables;'],
    ['DELETE FROM sys.objects;'],
    ['SELECT name FROM sqlite_master;'],
    ["UPDATE mysql.user SET host = '%';"],
  ];
  for (const add of fixtures) assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add })), 2, add.join(' '));
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ['INSERT INTO t (id) SELECT id FROM s;'] })), 1);
});

test('DDL words inside sql string literals do not make a fixture a schema file', () => {
  const fixtures = [
    ["INSERT INTO users (name) VALUES ('Grant');"],
    ["INSERT INTO notes (body) VALUES ('please comment on this');"],
    ['INSERT INTO verbs (v) VALUES', "  ('create'), ('drop'), ('rename');"],
    ["INSERT INTO t (s) VALUES ('it''s CREATE TABLE time');"],
  ];
  for (const add of fixtures) assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add })), 1, add.join(' '));
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ["SELECT 'x'; DROP TABLE t;"] })), 2);
  assert.equal(tier(file('tests/fixtures/db/seed.sql', { created: true, add: ["SELECT 'unterminated; DROP TABLE t;"] })), 2);
});

test('a suppression token in a .jsx or .tsx file always counts, inside quotes or not', () => {
  const lines = [
    "      <p>Rock 'n roll {/* eslint-disable-line react/no-unescaped-entities */} and 'em</p>",
    '      <p>"Quote {/* eslint-disable-line react/no-unescaped-entities */} unquote"</p>',
    '  const s = "eslint-disable";',
  ];
  for (const p of ['src/App.tsx', 'src/App.jsx']) {
    for (const l of lines) assert.equal(tier(file(p, { add: [l] })), 2, `${p}: ${l}`);
  }
});

test('a .sql fixture with dollar quotes, escape strings or backslashes is a schema file', () => {
  const fixtures = [
    ['SELECT $$it\'s$$;', 'DROP TABLE users;', "SELECT $$'$$;"],
    ["SELECT E'a\\\\' b';", 'DROP TABLE users;', "SELECT E'c\\\\' d';"],
    ["SELECT format('DROP TABLE %I', 'users') \\gexec"],
    ["INSERT INTO t (s) VALUES (e'x');"],
    ['SELECT $1;'],
  ];
  for (const add of fixtures) assert.equal(tier(file('tests/fixtures/seed.sql', { created: true, add })), 2, add.join(' '));
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
