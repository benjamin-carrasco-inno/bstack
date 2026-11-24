import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../plugins/bstack/skills/verify/browser-check-run.mjs', import.meta.url));

test('browser check runner without an origin prints usage and exits 2 before starting a browser', () => {
  const run = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node browser-check-run\.mjs <origin>/);
});

test('browser check runner rejects a flag without a value, bad widths and a non-http origin with usage', () => {
  for (const args of [['http://127.0.0.1:9', '--widths'], ['http://127.0.0.1:9', '--widths', '375,wide'], ['not a url'], ['file:///tmp/page.html']]) {
    const run = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: node browser-check-run\.mjs/, args.join(' '));
  }
});

const macBrowsers = process.platform === 'darwin' && 'macOS candidates are fixed /Applications paths that PATH cannot hide';

test('browser check runner without any browser exits 2 and leaves no temp profile', { skip: macBrowsers }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const nowhere = path.join(tmp, 'nowhere');
  const env = { PATH: nowhere, PROGRAMFILES: nowhere, 'PROGRAMFILES(X86)': nowhere, LOCALAPPDATA: nowhere, TMPDIR: tmp, TEMP: tmp, TMP: tmp, SystemRoot: process.env.SystemRoot ?? '' };
  const run = spawnSync(process.execPath, [runner, 'http://127.0.0.1:9'], { encoding: 'utf8', env });
  const left = fs.readdirSync(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no Chrome or Edge found/);
  assert.deepEqual(left, []);
});

test('browser check runner with an unknown browser path exits 2 and names the problem', () => {
  const run = spawnSync(process.execPath, [runner, 'http://127.0.0.1:9', '--browser', 'no-such-browser-exe'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no-such-browser-exe|ENOENT/);
});
