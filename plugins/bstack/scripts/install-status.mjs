#!/usr/bin/env node
// Reports, per Claude config dir, which bstack commit is installed against main and whether auto-update is on,
// with the command that brings that profile current. Read-only.
// Usage: node install-status.mjs [configDir...]   Default: $CLAUDE_CONFIG_DIR, else ~/.claude.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = 'bstack@bstack';
const MARKETPLACE = 'bstack';
const REPO_URL = 'https://github.com/benjamin-carrasco-inno/bstack.git';

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

export function profileState(configDir) {
  const installs = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'))?.plugins?.[PLUGIN] ?? [];
  const settings = readJson(path.join(configDir, 'settings.json'));
  return {
    configDir,
    installed: installs.map(i => i.gitCommitSha).find(Boolean) ?? null,
    autoUpdate: settings?.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate === true,
  };
}

export const updateCommand = configDir =>
  `CLAUDE_CONFIG_DIR="${configDir}" claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN}`;

export function statusLine(state, mainSha) {
  const short = sha => (sha ? sha.slice(0, 7) : 'none');
  const current = Boolean(state.installed) && state.installed === mainSha;
  const parts = [`${state.configDir}: installed ${short(state.installed)}, main ${short(mainSha)}`];
  parts.push(current ? 'current' : 'behind');
  parts.push(`auto-update ${state.autoUpdate ? 'on' : `off (set extraKnownMarketplaces.${MARKETPLACE}.autoUpdate: true in settings.json)`}`);
  const line = parts.join(', ');
  return current ? line : `${line}\n  update: ${updateCommand(state.configDir)}, then restart open sessions`;
}

function mainSha() {
  const out = execFileSync('git', ['ls-remote', REPO_URL, 'refs/heads/main'], { encoding: 'utf8' });
  return out.split(/\s/)[0] || null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [defaultDir];
  const main = mainSha();
  console.log(dirs.map(dir => statusLine(profileState(dir), main)).join('\n'));
}
