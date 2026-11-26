#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const USAGE = 'usage: node browser-check-run.mjs <origin> <path>... [--widths 375,768,1280] [--browser <exe>] [--timeout 120] [--login <path> --user <name> --password <secret>] [--cookie <name>=<value>]...';
const HEIGHT = 900;
const DEFAULT_WIDTHS = [375, 768, 1280];
const [SWEEP_FROM, SWEEP_TO] = [320, 1600];
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
  const args = { paths: [], widths: undefined, browser: process.env.BROWSER_CHECK_BROWSER, timeoutSeconds: 120, cookies: [] };
  const value = i => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--widths') args.widths = value(i++).split(',').map(Number);
    else if (argv[i] === '--browser') args.browser = value(i++);
    else if (argv[i] === '--timeout') args.timeoutSeconds = Number(value(i++));
    else if (argv[i] === '--login') args.login = value(i++);
    else if (argv[i] === '--user') args.user = value(i++);
    else if (argv[i] === '--password') args.password = value(i++);
    else if (argv[i] === '--cookie') args.cookies.push(value(i++));
    else if (!args.origin) args.origin = argv[i];
    else args.paths.push(argv[i]);
  }
  if (!URL.canParse(args.origin ?? '') || !/^https?:$/.test(new URL(args.origin).protocol)) throw new Error(USAGE);
  if (args.widths?.some(w => !Number.isInteger(w) || w < 1)) throw new Error(`--widths takes positive integers, such as 375,768,1280\n${USAGE}`);
  if (!(args.timeoutSeconds > 0 && args.timeoutSeconds <= 86400)) throw new Error(`--timeout takes seconds above 0 and up to 86400\n${USAGE}`);
  if (args.login && !(args.user && args.password)) throw new Error(`--login needs --user and --password\n${USAGE}`);
  if (args.cookies.some(c => !/^[^=;\s]+=[^;]*$/.test(c))) throw new Error(`--cookie takes one <name>=<value>\n${USAGE}`);
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

const RESIZE_BINDING = '__browserCheckResize';
const RESIZED = '__browserCheckResized';
const RESIZE_IN_PAGE = `width => new Promise(done => { globalThis.${RESIZED} = done; globalThis.${RESIZE_BINDING}(String(width)); })`;

async function openTab(cdp, paths, stop) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.on('Inspector.targetCrashed', msg => msg.sessionId === sessionId && stop(new Error(`the page crashed while checking ${paths.join(', ')}`)));
  await cdp.send('Inspector.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  cdp.on('Page.javascriptDialogOpening', msg => cdp.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {}));
  await cdp.send('Runtime.addBinding', { name: RESIZE_BINDING }, sessionId);
  cdp.on('Runtime.bindingCalled', ({ sessionId: from, params }) => {
    if (from !== sessionId || params.name !== RESIZE_BINDING) return;
    setWidth(cdp, sessionId, Number(params.payload))
      .then(() => cdp.send('Runtime.evaluate', { expression: `globalThis.${RESIZED}()`, contextId: params.executionContextId }, sessionId))
      .catch(stop);
  });
  return sessionId;
}

const setWidth = (cdp, sessionId, width) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);

async function visit(cdp, sessionId, url, shownPath) {
  const loaded = cdp.nextEvent('Page.loadEventFired', sessionId);
  const { errorText } = await cdp.send('Page.navigate', { url: url.href }, sessionId);
  if (errorText) throw await navigationError(url, shownPath, errorText);
  await loaded;
  const landed = new URL(await evaluate(cdp, sessionId, 'location.href'));
  if (!/^https?:$/.test(landed.protocol)) throw new Error(`could not open ${url.href}; is the app running?`);
  return landed;
}

const samePage = (a, b) => a.origin + a.pathname === b.origin + b.pathname;

const FILL_LOGIN = `(({ user, password }) => {
  const secret = document.querySelector('input[type="password"]');
  if (!secret?.form) throw new Error('no password field inside a form');
  const name = secret.form.querySelector('input:not([type]), input[type="text"], input[type="email"]');
  const set = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (name) set(name, user);
  set(secret, password);
  secret.form.requestSubmit();
})`;

async function signIn(cdp, sessionId, args) {
  for (const cookie of args.cookies) {
    const [name, ...value] = cookie.split('=');
    await cdp.send('Network.setCookie', { name, value: value.join('='), url: args.origin }, sessionId);
  }
  if (!args.login) return;
  const login = new URL(args.login, args.origin);
  const shown = login.pathname + login.search;
  const before = (await visit(cdp, sessionId, login, shown)).href;
  const outcome = await afterSubmit(cdp, sessionId, before, () => evaluate(cdp, sessionId, `${FILL_LOGIN}(${JSON.stringify({ user: args.user, password: args.password })})`).catch(error => {
    throw new Error(`sign-in at ${shown}: ${error.message}`);
  }));
  if (!outcome) throw new Error(`sign-in at ${shown} changed nothing within ${SIGN_IN_WAIT_MS / 1000} s (no page load, URL change or new cookie); check --user and --password`);
  if (samePage(outcome.landed, login) && !outcome.newCookie) throw new Error(`sign-in at ${shown} stayed on ${shown}; check --user and --password`);
}

const SIGN_IN_WAIT_MS = 5000;

async function afterSubmit(cdp, sessionId, before, submit) {
  const page = { loading: false, loads: 0 };
  cdp.on('Page.frameStartedLoading', msg => msg.sessionId === sessionId && (page.loading = true));
  cdp.on('Page.frameStoppedLoading', msg => msg.sessionId === sessionId && (page.loading = false));
  cdp.on('Page.loadEventFired', msg => msg.sessionId === sessionId && page.loads++);
  const cookies = async () => JSON.stringify((await cdp.send('Network.getCookies', { urls: [before] }, sessionId)).cookies.map(c => [c.name, c.value]));
  const cookiesBefore = await cookies();
  await submit();
  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  while (page.loading || Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (page.loading) continue;
    const href = await evaluate(cdp, sessionId, 'document.readyState === "complete" && location.href').catch(() => false);
    if (!href) continue;
    const newCookie = (await cookies()) !== cookiesBefore;
    if (page.loads || newCookie || href !== before) return { landed: new URL(href), newCookie };
  }
  return null;
}

async function navigationError(start, startPath, errorText) {
  const answered = await responseOf(start, '').catch(() => undefined);
  if (answered) return new Error(`${startPath} answered ${answered.status} without a page to check (${errorText})`);
  return new Error(`could not open ${start.href} (${errorText}); is the app running?`);
}

function redirectError(redirects, origin) {
  const shown = href => (new URL(href).origin === origin ? href.slice(origin.length) : href);
  const list = redirects.map(([requested, landed]) => `${shown(requested)} redirected to ${shown(landed)}`).join(', ');
  return new Error(`${list}; pass the path it lands on, or sign in first with --login <path> --user <name> --password <secret> or --cookie <name>=<value>`);
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
  const sessionId = await openTab(cdp, paths, stop);
  await signIn(cdp, sessionId, args);
  const load = async (i, width) => {
    await setWidth(cdp, sessionId, width);
    const landed = await visit(cdp, sessionId, pages[i], paths[i]);
    if (!samePage(landed, pages[i])) throw redirectError([[pages[i].href, landed.href]], start.origin);
  };
  const checkLoaded = options => evaluate(cdp, sessionId, `(${check})({ ...${JSON.stringify(options)}, resize: ${RESIZE_IN_PAGE} })`);
  const report = { findings: [], breakpoints: [] };
  for (const [i, path] of paths.entries()) {
    for (const [n, width] of (args.widths ?? DEFAULT_WIDTHS).entries()) {
      await load(i, width);
      if (i === 0 && n === 0) await checkStatuses(cdp, sessionId, pages, paths, start.origin);
      report.findings.push(...(await checkLoaded({ paths: [path], widths: [width], statics: n === 0, sweep: false })).findings);
    }
    await load(i, SWEEP_FROM);
    report.breakpoints.push(...(await checkLoaded({ paths: [path], widths: [], range: [SWEEP_FROM, SWEEP_TO] })).breakpoints);
  }
  return report;
}

async function checkStatuses(cdp, sessionId, pages, paths, origin) {
  const statuses = await pageStatuses(cdp, sessionId, pages, paths);
  const redirects = statuses.filter(s => s.status >= 300 && s.status < 400 && s.landed);
  if (redirects.length) throw redirectError(redirects.map(s => [s.requested, s.landed]), origin);
  const missing = statuses.filter(s => s.status >= 400);
  if (missing.length) throw new Error(`pages did not load: ${missing.map(s => `${s.path} (${s.status})`).join(', ')}`);
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

const RUNNER_PROFILE = /^browser-check-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
const BROWSER_MARKERS = ['Local State', 'DevToolsActivePort'];

function isStale(dir, name) {
  const match = RUNNER_PROFILE.exec(name);
  if (!match || !BROWSER_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)))) return false;
  const ownerPid = match[1];
  if (ownerPid && !isRunning(Number(ownerPid))) return true;
  return Date.now() - fs.statSync(dir).mtimeMs > LONGEST_RUN_MS;
}

function removeStaleProfiles() {
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
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
