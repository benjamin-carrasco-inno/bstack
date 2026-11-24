import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../plugins/bstack/skills/verify/browser-check-run.mjs', import.meta.url));

test('browser check runner without an origin prints usage and exits 2 before starting a browser', () => {
  const run = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node browser-check-run\.mjs <origin>/);
});

test('browser check runner with an unknown browser path exits 2 and names the problem', () => {
  const run = spawnSync(process.execPath, [runner, 'http://127.0.0.1:9', '--browser', 'no-such-browser-exe'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no-such-browser-exe|ENOENT/);
});
