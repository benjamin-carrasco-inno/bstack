import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { riskTier, readRiskPaths } from '../plugins/bstack/scripts/risk-tier.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extraPaths = readRiskPaths(repoRoot);
const edit = p => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '+const x = 1;'].join('\n');

const gateFiles = [
  'plugins/bstack/scripts/guard.mjs',
  'plugins/bstack/scripts/lib/shell.mjs',
  'plugins/bstack/scripts/lib/verdicts.mjs',
  'plugins/bstack/scripts/risk-tier.mjs',
  'plugins/bstack/hooks/hooks.json',
];

for (const p of gateFiles) {
  test(`bstack's own risk-paths make a change to ${p} tier 2 and name it`, () => {
    const r = riskTier(edit(p), { extraPaths });
    assert.equal(r.tier, 2);
    assert.ok(r.reasons.includes(`listed in .github/risk-paths.txt: ${p}`), r.reasons.join('; '));
  });
}

test("bstack's own risk-paths leave a docs-only change at tier 0", () => {
  assert.equal(riskTier([edit('README.md'), edit('CHANGELOG.md')].join('\n'), { extraPaths }).tier, 0);
});
