import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

test('browser check runner removes the profiles of dead runs and keeps those of live runs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const pidReused = `browser-check-${process.pid}-old456`;
  const stale = [`browser-check-${deadPid}-abc123`, 'browser-check-old123', pidReused];
  const live = [`browser-check-${process.pid}-abc123`, 'browser-check-new123'];
  const foreign = ['browser-check-2024-results', 'browser-check-reports', 'browser-check-nomark'];
  for (const name of [...stale, ...live, ...foreign]) {
    fs.mkdirSync(path.join(tmp, name));
    fs.writeFileSync(path.join(tmp, name, name === 'browser-check-nomark' ? 'notes.txt' : 'Local State'), '{}');
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  for (const name of ['browser-check-old123', pidReused, ...foreign]) fs.utimesSync(path.join(tmp, name), twoDaysAgo, twoDaysAgo);
  const run = spawnSync(process.execPath, [runner, 'http://127.0.0.1:9', '--browser', 'no-such-browser-exe'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
  const left = fs.readdirSync(tmp).sort();
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(run.status, 2, run.stderr);
  assert.deepEqual(left, [...live, ...foreign].sort());
});

test('browser check runner with an unknown browser path exits 2 and names the problem', () => {
  const run = spawnSync(process.execPath, [runner, 'http://127.0.0.1:9', '--browser', 'no-such-browser-exe'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no-such-browser-exe|ENOENT/);
});

const fixture = name => fs.readFileSync(new URL(`fixtures/browser-check/${name}`, import.meta.url));
let releaseHeld;
const held = new Promise(resolve => { releaseHeld = resolve; });
const html = body => (_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
const routes = {
  '/': html(fixture('defects.html')),
  '/clean': html(fixture('clean.html')),
  '/delay': (req, res) => setTimeout(() => html(fixture('defects.html'))(req, res), Number(new URL(req.url, 'http://x').searchParams.get('ms'))),
  '/hanging-image': html('<!doctype html><html lang="en"><title>Hanging image</title><img src="/never" alt=""></html>'),
  '/never': () => server.emit('never-requested'),
  '/held': async (req, res) => {
    server.emit('held-requested');
    await held;
    html(fixture('clean.html'))(req, res);
  },
  '/settings': (_, res) => res.writeHead(302, { location: '/login' }).end(),
  '/no-content': (_, res) => res.writeHead(204).end(),
  '/login': html(fixture('clean.html')),
  '/spa': html(String(fixture('clean.html')).replace('</body>', '<script>history.replaceState(null, "", "/spa?tab=home")</script></body>')),
  '/app/docs/a': html(fixture('clean.html')),
  '/alert': html(String(fixture('clean.html')).replace('</body>', '<script>alert("Welcome")</script></body>')),
  '/csp-blocked-style': (_, res) => res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'none'" }).end(String(fixture('clean.html')).replace('</body>', '<style>body::after { content: ""; display: block; inline-size: 3000px; block-size: 1px; }</style></body>')),
  '/csp-connect-none': (_, res) => res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "connect-src 'none'" }).end(fixture('clean.html')),
  '/xfo-deny': (_, res) => res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }).end(fixture('clean.html')),
  '/csp-frame-ancestors-none': (_, res) => res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'" }).end(fixture('clean.html')),
  '/query': (req, res) => html(fixture(req.url.endsWith('?v=bad') ? 'defects.html' : 'clean.html'))(req, res),
};
const route = (req, res) => (routes[new URL(req.url, 'http://x').pathname] ?? ((_, r) => r.writeHead(404).end('not found')))(req, res);
const server = http.createServer(route);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
function selfSignedCertificate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(Buffer.from('06082a8648ce3d040302', 'hex'));
  const commonName = sequence(der(0x31, sequence(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('127.0.0.1')))));
  const utcTime = date => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
  const day = 86400000;
  const validity = sequence(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + day)));
  const serialOne = Buffer.from('020101', 'hex');
  const tbs = sequence(serialOne, ecdsaWithSha256, commonName, validity, commonName, publicKey.export({ type: 'spki', format: 'der' }));
  const signature = der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey));
  const cert = sequence(tbs, ecdsaWithSha256, signature).toString('base64').match(/.{1,64}/g).join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const secureServer = https.createServer(selfSignedCertificate(), route);
await new Promise(resolve => secureServer.listen(0, '127.0.0.1', resolve));
const secureOrigin = `https://127.0.0.1:${secureServer.address().port}`;

after(() => {
  for (const s of [server, secureServer]) {
    s.closeAllConnections();
    s.close();
  }
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
  const done = new Promise(resolve => child.on('close', status => {
    clearTimeout(giveUp);
    resolve({ status, stdout, stderr, seconds: (Date.now() - started) / 1000 });
  }));
  return Object.assign(done, { child });
}

const closed = http.createServer();
await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
const deadPort = closed.address().port;
await new Promise(resolve => closed.close(resolve));
const deadOrigin = await runAsync([`http://127.0.0.1:${deadPort}`]);
const noBrowser = /no Chrome or Edge found/.test(deadOrigin.stderr) && 'no Chrome or Edge on this machine; set BROWSER_CHECK_BROWSER to run the browser tests';

test('browser check runner exits 2 when nothing listens on the origin', { skip: noBrowser }, () => {
  assert.equal(deadOrigin.status, 2, deadOrigin.stderr);
  assert.match(deadOrigin.stderr, new RegExp(`could not open http://127\\.0\\.0\\.1:${deadPort}/ \\(net::ERR_CONNECTION_REFUSED\\); is the app running\\?`));
});

test('browser check runner exits 2 and names the status when the start page answers 204 without a document', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/no-content']);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /\/no-content answered 204/);
  assert.doesNotMatch(run.stderr, /is the app running/);
});

test('browser check runner reports the defects fixture with exit 1 and its breakpoint', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/']);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.findings.length, 5);
  assert.deepEqual(report.breakpoints.map(({ width }) => width), [640]);
  const [{ narrowestColumnCh }] = report.breakpoints;
  assert.ok(Number.isInteger(narrowestColumnCh) && narrowestColumnCh > 0, `ch depends on the platform font, got ${narrowestColumnCh}`);
});

test('browser check runner passes the clean fixture with exit 0', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/clean']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner given a page URL with a query and no paths checks that page with its query', { skip: noBrowser }, async () => {
  const run = await runAsync([`${origin}/query?v=bad`]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).findings.length, 5);
});

test('browser check runner accepts a start page that rewrites its own query with history.replaceState', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/spa']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner checks a page whose CSP blocks the page from fetching its own origin', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/csp-connect-none']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner dismisses an alert on the start page and in the checked pages', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/alert', '/clean', '/alert', '--timeout', '20']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner leaves the page CSP in force, so a style the CSP blocks causes no overflow', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/csp-blocked-style']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner resolves relative paths once, against an origin with a base path', { skip: noBrowser }, async () => {
  const run = await runAsync([`${origin}/app/`, 'docs/a']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner exits 2 when a page does not load', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/clean', '/missing']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /pages did not load: \/missing \(404\)/);
});

test('browser check runner exits 2 and names where it landed when the start page or another page redirects to login', { skip: noBrowser }, async () => {
  for (const args of [['/settings'], ['/clean', '/settings']]) {
    const run = await runAsync([origin, ...args]);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}`);
    assert.match(run.stderr, /\/settings redirected to \/login; .*no session/, args.join(' '));
  }
});

test('browser check runner exits 2 without a stack trace when a page refuses framing, and removes its profile', { skip: noBrowser }, async () => {
  for (const refusing of ['/xfo-deny', '/csp-frame-ancestors-none']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
    const run = await runAsync([origin, '/clean', refusing], { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    const left = fs.readdirSync(tmp).filter(name => name.startsWith('browser-check-'));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    assert.equal(run.status, 2, `${refusing}: ${run.stdout}${run.stderr}`);
    assert.ok(run.stderr.includes(`${refusing} refuses framing (X-Frame-Options or CSP frame-ancestors)`), run.stderr);
    assert.doesNotMatch(run.stderr, /TypeError|\n\s+at /, refusing);
    assert.deepEqual(left, [], refusing);
  }
});

test('browser check runner checks a local HTTPS origin with a self-signed certificate', { skip: noBrowser }, async () => {
  const run = await runAsync([secureOrigin, '/clean']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { findings: [], breakpoints: [] });
});

test('browser check runner waits for a start page that answers after 1000 ms', { skip: noBrowser }, async () => {
  const run = await runAsync([origin, '/delay?ms=1000']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(JSON.parse(run.stdout).findings.length, 5);
});

test('browser check runner gives up at --timeout on a page that never finishes loading and removes its profile', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const run = await runAsync([origin, '/hanging-image', '--timeout', '5'], { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  const left = fs.readdirSync(tmp);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /no result within 5 s/);
  assert.ok(run.seconds < 15, `took ${run.seconds} s`);
  assert.deepEqual(left, []);
});

const profilesIn = dir => fs.readdirSync(dir).filter(name => name.startsWith('browser-check-'));

test('browser check runner whose reader closes before the report still removes its profile and keeps its exit code', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const child = spawn(process.execPath, [runner, origin, '/clean'], { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [status] = await once(child, 'close');
  const left = profilesIn(tmp);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.deepEqual(left, []);
});

test('browser check runner killed by its reader after the first line of the report leaves no profile', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const child = spawn(process.execPath, [runner, origin, '/'], { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
  child.stdout.once('data', () => child.kill('SIGKILL'));
  await once(child, 'close');
  const left = profilesIn(tmp);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.deepEqual(left, []);
});

test('browser check runner keeps the profile of a concurrent run, and that run completes', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const env = { TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const requested = once(server, 'held-requested');
  const first = runAsync([origin, '/held'], env);
  await requested;
  const [profile] = profilesIn(tmp);
  const second = await runAsync([origin, '/clean'], env);
  const kept = fs.existsSync(path.join(tmp, profile));
  releaseHeld();
  const run = await first;
  const left = profilesIn(tmp);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(kept, `${profile} was removed while its run was going`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(left, []);
});

async function killRenderers(profile) {
  const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await once(ws, 'open');
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
  const [{ data }] = await reply;
  const { processInfo } = JSON.parse(data).result;
  for (const { id } of processInfo.filter(p => p.type === 'renderer')) process.kill(id, 'SIGKILL');
  ws.close();
}

test('browser check runner ends at once when the page renderer crashes, exits 2 and removes its profile', { skip: noBrowser }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const requested = once(server, 'never-requested');
  const running = runAsync([origin, '/hanging-image', '--timeout', '30'], { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  await requested;
  const [profile] = fs.readdirSync(tmp).filter(name => name.startsWith('browser-check-'));
  await killRenderers(path.join(tmp, profile));
  const run = await running;
  const left = fs.readdirSync(tmp).filter(name => name.startsWith('browser-check-'));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /the page crashed while checking \/hanging-image/);
  assert.doesNotMatch(run.stderr, /--timeout/);
  assert.ok(run.seconds < 15, `took ${run.seconds} s`);
  assert.deepEqual(left, []);
});

const windowsKillsHard = process.platform === 'win32' && 'on Windows child.kill() terminates without a signal the runner can handle';

test('browser check runner stopped by SIGTERM exits 2 and removes its profile', { skip: noBrowser || windowsKillsHard }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const requested = once(server, 'never-requested');
  const running = runAsync([origin, '/hanging-image'], { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  await requested;
  running.child.kill('SIGTERM');
  const run = await running;
  const left = fs.readdirSync(tmp).filter(name => name.startsWith('browser-check-'));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /stopped by SIGTERM/);
  assert.deepEqual(left, []);
});
