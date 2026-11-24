import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../plugins/bstack/skills/verify/browser-check.js', import.meta.url), 'utf8');

test('browser check is one expression, so an agent can inject the file followed by its arguments', async () => {
  assert.equal(typeof vm.runInNewContext(source), 'function');
  const result = await vm.runInNewContext(`${source.trimEnd()}({ paths: [] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { findings: [], breakpoints: [] });
});

test('browser check fixtures exist', () => {
  for (const name of ['defects.html', 'clean.html']) {
    assert.ok(fs.existsSync(new URL(`fixtures/browser-check/${name}`, import.meta.url)), name);
  }
});
