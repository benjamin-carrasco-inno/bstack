import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../plugins/bstack/skills/verify/browser-check-run.mjs', import.meta.url));

test('browser check runner without an origin prints usage and exits 2 before starting a browser', () => {
  const run = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node browser-check-run\.mjs <origin>/);
});

test('browser check runner rejects a flag without a value, bad widths, a bad timeout and a non-http origin with usage', () => {
  for (const args of [['http://127.0.0.1:9', '--widths'], ['http://127.0.0.1:9', '--widths', '375,wide'], ['http://127.0.0.1:9', '--timeout', '0'], ['http://127.0.0.1:9', '--timeout', 'soon'], ['not a url'], ['file:///tmp/page.html']]) {
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

const fixture = name => fs.readFileSync(new URL(`fixtures/browser-check/${name}`, import.meta.url));
const html = body => (_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
const routes = {
  '/': html(fixture('defects.html')),
  '/clean': html(fixture('clean.html')),
  '/delay': (req, res) => setTimeout(() => html(fixture('defects.html'))(req, res), Number(new URL(req.url, 'http://x').searchParams.get('ms'))),
  '/hanging-image': html('<!doctype html><html lang="en"><title>Hanging image</title><img src="/never" alt=""></html>'),
  '/never': () => {},
};
const server = http.createServer((req, res) => (routes[new URL(req.url, 'http://x').pathname] ?? ((_, r) => r.writeHead(404).end('not found')))(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const GIVE_UP_MS = 60000;
function runAsync(args, env = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [runner, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const giveUp = setTimeout(() => child.kill('SIGKILL'), GIVE_UP_MS);
  return new Promise(resolve => child.on('close', status => {
    clearTimeout(giveUp);
    resolve({ status, stdout, stderr, seconds: (Date.now() - started) / 1000 });
  }));
}

const deadOrigin = await runAsync(['http://127.0.0.1:9']);
const noBrowser = /no Chrome or Edge found/.test(deadOrigin.stderr) && 'no Chrome or Edge on this machine; set BROWSER_CHECK_BROWSER to run the browser tests';

test('browser check runner exits 2 when nothing listens on the origin', { skip: noBrowser }, () => {
  assert.equal(deadOrigin.status, 2, deadOrigin.stderr);
  assert.match(deadOrigin.stderr, /could not open http:\/\/127\.0\.0\.1:9\//);
});

test('browser check runner reports the defects fixture with exit 1 and its breakpoint', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/']);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.findings.length, 5);
  assert.deepEqual(report.breakpoints.map(({ width, narrowestColumnCh }) => ({ width, narrowestColumnCh })), [{ width: 640, narrowestColumnCh: 35 }]);
});

test('browser check runner passes the clean fixture with exit 0', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/clean']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner exits 2 when a page does not load', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/clean', '/missing']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /pages did not load: \/missing \(404\)/);
});

test('browser check runner waits for a start page that answers after 1000 ms', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/delay?ms=1000']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(JSON.parse(run.stdout).findings.length, 5);
});

test('browser check runner gives up at --timeout on a page that never finishes loading and removes its profile', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const run = await runAsync([origin, '/hanging-image', '--timeout', '5'], { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  const left = fs.readdirSync(tmp).filter(name => name.startsWith('browser-check-'));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /no result within 5 s/);
  assert.ok(run.seconds < 15, `took ${run.seconds} s`);
  assert.deepEqual(left, []);
});
