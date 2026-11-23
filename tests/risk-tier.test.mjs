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
