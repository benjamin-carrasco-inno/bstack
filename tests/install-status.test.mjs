import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainSha, profileState, statusLine } from '../plugins/bstack/scripts/install-status.mjs';

const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NO_MANAGED = path.join(os.tmpdir(), 'no-such-managed-settings.json');

function profile({ installed, autoUpdate, settings = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bstack-profile-'));
  fs.mkdirSync(path.join(dir, 'plugins'));
  if (installed) {
    const plugins = { 'bstack@bstack': [{ scope: 'user', gitCommitSha: installed }] };
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  }
  if (settings) {
    const source = { source: 'git', url: 'https://github.com/benjamin-carrasco-inno/bstack.git' };
    const bstack = autoUpdate === undefined ? { source } : { source, autoUpdate };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { bstack } }));
  }
  return dir;
}

test('a profile on main with auto-update on is current and gets no update command', () => {
  const line = statusLine(profileState(profile({ installed: MAIN, autoUpdate: true })), MAIN);
  assert.match(line, /installed aaaaaaa, main aaaaaaa, current, auto-update on$/);
});

test('a profile behind main names both commits and the command for that config dir', () => {
  const dir = profile({ installed: OLD, autoUpdate: true });
  const line = statusLine(profileState(dir), MAIN);
  assert.match(line, /installed bbbbbbb, main aaaaaaa, behind/);
  assert.ok(line.includes(`export CLAUDE_CONFIG_DIR="${dir}"; claude plugin marketplace update bstack && claude plugin update bstack@bstack`));
  assert.ok(line.includes(`$env:CLAUDE_CONFIG_DIR = "${dir}"; claude plugin marketplace update bstack; if ($?) { claude plugin update bstack@bstack }`));
  assert.equal(line.split('then restart open sessions').length, 2);
});

test('each update form sets the config dir before both commands, each on its own line', () => {
  const dir = profile({ installed: OLD, autoUpdate: true });
  const lines = statusLine(profileState(dir), MAIN).split('\n');
  for (const setter of [`export CLAUDE_CONFIG_DIR="${dir}";`, `$env:CLAUDE_CONFIG_DIR = "${dir}";`]) {
    const form = lines.find(l => l.includes(setter));
    assert.ok(form, setter);
    const after = form.slice(form.indexOf(setter) + setter.length);
    assert.ok(after.includes('claude plugin marketplace update bstack'));
    assert.ok(after.includes('claude plugin update bstack@bstack'));
  }
});

test('auto-update missing or not literally true is off, with the setting that turns it on', () => {
  for (const autoUpdate of [undefined, false, 'true']) {
    const line = statusLine(profileState(profile({ installed: MAIN, autoUpdate }), NO_MANAGED), MAIN);
    assert.match(line, /auto-update off in settings\.json and managed-settings\.json \(set extraKnownMarketplaces\.bstack\.autoUpdate: true in settings\.json\)/);
  }
});

test('a profile without bstack installed or without settings is behind, not an error', () => {
  const line = statusLine(profileState(profile({ settings: false }), NO_MANAGED), MAIN);
  assert.match(line, /installed none, main aaaaaaa, behind, auto-update off/);
  assert.match(line, /update \(sh\): /);
});

test('an unreadable main commit never reports a profile as current', () => {
  assert.match(statusLine(profileState(profile({ installed: MAIN, autoUpdate: true })), null), /behind/);
});

test('auto-update set in managed settings is reported on, with its scope', () => {
  const managed = path.join(profile(), 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ extraKnownMarketplaces: { bstack: { autoUpdate: true } } }));
  const line = statusLine(profileState(profile({ installed: MAIN }), managed), MAIN);
  assert.match(line, /auto-update on \(managed\)$/);
});

test('auto-update off names the files it read, so a policy from elsewhere is not reported as plainly off', () => {
  const line = statusLine(profileState(profile({ installed: MAIN }), NO_MANAGED), MAIN);
  assert.match(line, /auto-update off in settings\.json and managed-settings\.json \(/);
});

test('git ls-remote runs with a 15 s timeout by default', () => {
  let options;
  mainSha((cmd, args, opts) => { options = opts; return `${MAIN}\trefs/heads/main\n`; });
  assert.equal(options.timeout, 15_000);
});

test('a hanging ls-remote is killed at the timeout and main is unknown', () => {
  const hang = (cmd, args, opts) => execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], opts);
  const started = Date.now();
  assert.equal(mainSha(hang, 300), null);
  assert.ok(Date.now() - started < 3_000);
});

test('main is unknown, not a crash, when git ls-remote fails', () => {
  const main = mainSha(() => { throw new Error('spawn git ENOENT'); });
  assert.equal(main, null);
  const line = statusLine(profileState(profile({ installed: MAIN, autoUpdate: true })), main);
  assert.match(line, /main unknown, behind/);
});
