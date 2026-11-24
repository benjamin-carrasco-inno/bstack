#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = 'usage: node browser-check-run.mjs <origin> <path>... [--widths 375,768,1280] [--browser <exe>]';
const CANDIDATES = {
  win32: [
    `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

function parseArgs(argv) {
  const args = { paths: [], widths: undefined, browser: process.env.BROWSER_CHECK_BROWSER };
  const value = i => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--widths') args.widths = value(i++).split(',').map(Number);
    else if (argv[i] === '--browser') args.browser = value(i++);
    else if (!args.origin) args.origin = argv[i];
    else args.paths.push(argv[i]);
  }
  if (!URL.canParse(args.origin ?? '') || !/^https?:$/.test(new URL(args.origin).protocol)) throw new Error(USAGE);
  if (args.widths?.some(w => !Number.isInteger(w) || w < 1)) throw new Error(`--widths takes positive integers, such as 375,768,1280\n${USAGE}`);
  if (!args.paths.length) args.paths.push(new URL(args.origin).pathname);
  return args;
}

function findBrowser(explicit) {
  if (explicit) return explicit;
  const onPath = name => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name)).find(p => fs.existsSync(p));
  for (const candidate of CANDIDATES[process.platform] ?? CANDIDATES.linux) {
    const found = path.isAbsolute(candidate) ? (fs.existsSync(candidate) && candidate) : onPath(candidate);
    if (found) return found;
  }
  throw new Error('no Chrome or Edge found; pass --browser <exe>');
}

function launch(exe, profile) {
  const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = new Promise((resolve, reject) => {
    let log = '';
    child.stderr.on('data', chunk => {
      log += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m) resolve(m[1]);
    });
    child.on('error', error => reject(new Error(`cannot start ${exe}: ${error.message}`)));
    child.on('exit', code => reject(new Error(`browser exited (${code}) before DevTools was ready:\n${log}`)));
    setTimeout(() => reject(new Error('browser did not open DevTools within 20 s')), 20000).unref();
  });
  return { child, endpoint };
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let next = 0;
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ send, close: () => ws.close() }));
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)));
  });
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function main() {
  if (typeof WebSocket === 'undefined') throw new Error('needs Node 22 or later (global WebSocket)');
  const args = parseArgs(process.argv.slice(2));
  const check = fs.readFileSync(new URL('./browser-check.js', import.meta.url), 'utf8').trim();
  const browser = findBrowser(args.browser);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-check-'));
  const { child, endpoint } = launch(browser, profile);
  let cdp;
  try {
    cdp = await connect(await endpoint);
    const start = new URL(args.paths[0], args.origin);
    const { targetId } = await cdp.send('Target.createTarget', { url: start.href });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const loaded = await evaluate(cdp, sessionId, `new Promise(r => document.readyState === 'complete' ? r(location.origin) : addEventListener('load', () => r(location.origin), { once: true }))`);
    if (loaded !== start.origin) throw new Error(`could not open ${start.href}; is the app running?`);
    const statuses = await evaluate(cdp, sessionId, `Promise.all(${JSON.stringify(args.paths)}.map(p => fetch(p, { credentials: 'include' }).then(r => [p, r.status])))`);
    const missing = statuses.filter(([, status]) => status >= 400);
    if (missing.length) throw new Error(`pages did not load: ${missing.map(([p, status]) => `${p} (${status})`).join(', ')}`);
    const options = JSON.stringify({ paths: args.paths, ...(args.widths && { widths: args.widths }) });
    const report = await evaluate(cdp, sessionId, `(${check})(${options})`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.findings.length ? 1 : 0;
  } finally {
    await closeBrowser(child, cdp);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

async function closeBrowser(child, cdp) {
  if (!child.pid || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  const within = ms => Promise.race([exited, new Promise(resolve => setTimeout(resolve, ms).unref())]);
  if (cdp) {
    cdp.send('Browser.close').catch(() => {});
    await within(5000);
    cdp.close();
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await within(5000);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 2;
});
