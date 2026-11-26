#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const USAGE = 'usage: node browser-check-run.mjs <origin> <path>... [--widths 375,768,1280] [--browser <exe>] [--timeout 120]';
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
  const args = { paths: [], widths: undefined, browser: process.env.BROWSER_CHECK_BROWSER, timeoutSeconds: 120 };
  const value = i => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--widths') args.widths = value(i++).split(',').map(Number);
    else if (argv[i] === '--browser') args.browser = value(i++);
    else if (argv[i] === '--timeout') args.timeoutSeconds = Number(value(i++));
    else if (!args.origin) args.origin = argv[i];
    else args.paths.push(argv[i]);
  }
  if (!URL.canParse(args.origin ?? '') || !/^https?:$/.test(new URL(args.origin).protocol)) throw new Error(USAGE);
  if (args.widths?.some(w => !Number.isInteger(w) || w < 1)) throw new Error(`--widths takes positive integers, such as 375,768,1280\n${USAGE}`);
  if (!(args.timeoutSeconds > 0 && args.timeoutSeconds <= 86400)) throw new Error(`--timeout takes seconds above 0 and up to 86400\n${USAGE}`);
  const { pathname, search } = new URL(args.origin);
  if (!args.paths.length) args.paths.push(pathname + search);
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
  const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: profile, TEMP: profile, TMPDIR: profile } });
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
  const eventWaiters = new Set();
  let next = 0;
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.method) {
      for (const waiter of eventWaiters) waiter(msg);
      return;
    }
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
  const nextEvent = (method, sessionId) => new Promise(resolve => {
    const waiter = msg => {
      if (msg.method !== method || msg.sessionId !== sessionId) return;
      eventWaiters.delete(waiter);
      resolve(msg.params);
    };
    eventWaiters.add(waiter);
  });
  const on = (method, handler) => eventWaiters.add(msg => msg.method === method && handler(msg));
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ send, nextEvent, on, close: () => ws.close() }));
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)));
  });
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(failureOf(exceptionDetails));
  return result.value;
}

function failureOf({ exception, text }) {
  const description = exception?.description ?? text;
  const deliberate = exception?.className === 'Error';
  return deliberate ? description.split('\n')[0].replace(/^Error: /, '') : description;
}

async function openStartPage(cdp, start, paths, stop) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.on('Inspector.targetCrashed', msg => msg.sessionId === sessionId && stop(new Error(`the page crashed while checking ${paths.join(', ')}`)));
  await cdp.send('Inspector.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  cdp.on('Page.javascriptDialogOpening', msg => cdp.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {}));
  const loaded = cdp.nextEvent('Page.loadEventFired', sessionId);
  const { errorText } = await cdp.send('Page.navigate', { url: start.href }, sessionId);
  if (errorText) throw await navigationError(start, paths[0], errorText);
  await loaded;
  const landed = new URL(await evaluate(cdp, sessionId, 'location.href'));
  if (!/^https?:$/.test(landed.protocol)) throw new Error(`could not open ${start.href}; is the app running?`);
  if (landed.origin + landed.pathname !== start.origin + start.pathname) throw redirectError([[start.href, landed.href]], start.origin);
  return sessionId;
}

async function navigationError(start, startPath, errorText) {
  const answered = await responseOf(start, '').catch(() => undefined);
  if (answered) return new Error(`${startPath} answered ${answered.status} without a page to check (${errorText})`);
  return new Error(`could not open ${start.href} (${errorText}); is the app running?`);
}

function redirectError(redirects, origin) {
  const shown = href => (new URL(href).origin === origin ? href.slice(origin.length) : href);
  const list = redirects.map(([requested, landed]) => `${shown(requested)} redirected to ${shown(landed)}`).join(', ');
  return new Error(`${list}; pass the path it lands on, or for a page behind login inject browser-check.js in a signed-in browser (the runner has no session)`);
}

function responseOf(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, { headers: { cookie }, rejectUnauthorized: false }, res => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    request.on('error', reject);
  });
}

async function pageStatuses(cdp, sessionId, pages, paths) {
  return Promise.all(pages.map(async (url, i) => {
    const { cookies } = await cdp.send('Network.getCookies', { urls: [url.href] }, sessionId);
    const { status, location } = await responseOf(url, cookies.map(c => `${c.name}=${c.value}`).join('; '));
    return { path: paths[i], requested: url.href, status, landed: location && new URL(location, url).href };
  }));
}

async function runCheck(cdp, args, check, stop) {
  const pages = args.paths.map(p => new URL(p, args.origin));
  const [start] = pages;
  const sameOriginPath = url => (url.origin === start.origin ? url.pathname + url.search + url.hash : url.href);
  const paths = pages.map(sameOriginPath);
  const sessionId = await openStartPage(cdp, start, paths, stop);
  const statuses = await pageStatuses(cdp, sessionId, pages, paths);
  const redirects = statuses.filter(s => s.status >= 300 && s.status < 400 && s.landed);
  if (redirects.length) throw redirectError(redirects.map(s => [s.requested, s.landed]), start.origin);
  const missing = statuses.filter(s => s.status >= 400);
  if (missing.length) throw new Error(`pages did not load: ${missing.map(s => `${s.path} (${s.status})`).join(', ')}`);
  const options = JSON.stringify({ paths, ...(args.widths && { widths: args.widths }) });
  return evaluate(cdp, sessionId, `(${check})(${options})`);
}

function giveUpSignal(seconds) {
  let timer;
  let stop;
  const stopped = new Promise((_, reject) => {
    stop = reject;
    timer = setTimeout(() => reject(new Error(`no result within ${seconds} s; a page or one of its resources may never finish loading (raise --timeout for a slow app)`)), seconds * 1000);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => reject(new Error(`stopped by ${signal}`)));
  });
  return { stopped, stop, clear: () => clearTimeout(timer) };
}

const PROFILE_PREFIX = 'browser-check-';
const LONGEST_RUN_MS = 86400 * 1000 + 60000;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isStale(dir, name) {
  const ownerPid = /^browser-check-(\d+)-/.exec(name)?.[1];
  if (ownerPid) return !isRunning(Number(ownerPid));
  return Date.now() - fs.statSync(dir).mtimeMs > LONGEST_RUN_MS;
}

function removeStaleProfiles() {
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(tmp, entry.name);
    try {
      if (isStale(dir, entry.name)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  if (typeof WebSocket === 'undefined') throw new Error('needs Node 22 or later (global WebSocket)');
  const args = parseArgs(process.argv.slice(2));
  removeStaleProfiles();
  const check = fs.readFileSync(new URL('./browser-check.js', import.meta.url), 'utf8').trim();
  const browser = findBrowser(args.browser);
  const giveUp = giveUpSignal(args.timeoutSeconds);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
  const { child, endpoint } = launch(browser, profile);
  let cdp;
  let report;
  try {
    const work = endpoint.then(connect).then(connected => runCheck(cdp = connected, args, check, giveUp.stop));
    report = await Promise.race([work, giveUp.stopped]);
  } finally {
    giveUp.clear();
    await closeBrowser(child, cdp);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  process.exitCode = report.findings.length ? 1 : 0;
  process.stdout.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
  console.log(JSON.stringify(report, null, 2));
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
