import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileState, statusLine } from '../plugins/bstack/scripts/install-status.mjs';

const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

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
  assert.ok(line.includes(`CLAUDE_CONFIG_DIR="${dir}" claude plugin marketplace update bstack && claude plugin update bstack@bstack`));
});

test('auto-update missing or not literally true is off, with the setting that turns it on', () => {
  for (const autoUpdate of [undefined, false, 'true']) {
    const line = statusLine(profileState(profile({ installed: MAIN, autoUpdate })), MAIN);
    assert.match(line, /auto-update off \(set extraKnownMarketplaces\.bstack\.autoUpdate: true in settings\.json\)/);
  }
});

test('a profile without bstack installed or without settings is behind, not an error', () => {
  const line = statusLine(profileState(profile({ settings: false })), MAIN);
  assert.match(line, /installed none, main aaaaaaa, behind, auto-update off/);
  assert.match(line, /update: /);
});

test('an unreadable main commit never reports a profile as current', () => {
  assert.match(statusLine(profileState(profile({ installed: MAIN, autoUpdate: true })), null), /behind/);
});
