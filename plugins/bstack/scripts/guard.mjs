#!/usr/bin/env node
// PreToolUse guard for Bash, PowerShell, file writes and MCP tools. It blocks what a rule in prose
// cannot hold: pushes to the default branch, skipped hooks, force-pushes, rebasing pushed branches,
// merges without green CI and a reviewer verdict for the head SHA, merges through side doors
// (gh api, MCP), and forged verdicts. Exit 2 with a message that names the right alternative.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsIn, parseGit } from './lib/shell.mjs';
import { MARKER, latestFor } from './lib/verdicts.mjs';
import { riskTier, readRiskPaths } from './risk-tier.mjs';

const DEFAULT_BRANCH = /^(main|master)$/;
const READ_ONLY = new Set(['grep', 'rg', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content', 'gc', 'jq', 'less', 'head', 'tail', 'wc']);
const NO_AUTHORING_AGENTS = /(^|:)(reviewer|adversary)$/;

export function decide(input, deps) {
  const tool = String(input.tool_name ?? '');
  const cwd = input.cwd || process.cwd();
  const agent = String(input.agent_type ?? '');
  if (tool.startsWith('mcp__')) return mcpRule(tool, input.tool_input ?? {});
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return writeRule(input.tool_input ?? {}, deps);
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const line = String(input.tool_input?.command ?? '');
  for (const c of commandsIn(line)) {
    const reason = markerRule(c, cwd, deps) ?? agentRule(c, agent) ?? (c.cmd === 'git' ? gitRule(c, cwd, deps) : null) ?? (c.cmd === 'gh' ? ghRule(c, cwd, deps) : null);
    if (reason) return reason;
  }
  return null;
}

// --- verdict marker: only the SubagentStop hook writes it -------------------------------------
function markerRule(c, cwd, deps) {
  const readOnlyGh = c.cmd === 'gh' && (/^(view|checks|diff|list|status)$/.test(c.args[1] ?? '') || (c.args[0] === 'api' && !hasWriteFields(c.args)));
  if (MARKER.test(c.text) && !READ_ONLY.has(c.cmd) && !readOnlyGh) {
    return 'Verdict and interrogate lines are posted by the bstack hook when the bstack:reviewer or bstack:adversary agent finishes. Run that agent instead of writing the line yourself.';
  }
  if (c.cmd === 'gh') {
    for (const file of bodyFiles(c.args)) {
      const text = deps.readFile(path.resolve(cwd, file));
      if (text && MARKER.test(text)) return `The body file ${file} contains a bstack verdict line. Verdicts are posted only by the bstack hook.`;
    }
  }
  return null;
}

function bodyFiles(args) {
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--body-file' || a === '-F' || a === '--input') files.push(args[i + 1]);
    else if (a.startsWith('--body-file=') || a.startsWith('--input=')) files.push(a.split('=').slice(1).join('='));
    if ((a === '-F' || a === '--field') && /=@/.test(args[i + 1] ?? '')) files.push(args[i + 1].split('=@')[1]);
  }
  return files.filter(f => f && f !== '-' && !f.includes('=@'));
}

// --- reviewer and adversary judge; they never author ---------------------------------------------
function agentRule(c, agent) {
  if (!NO_AUTHORING_AGENTS.test(agent)) return null;
  const git = c.cmd === 'git' ? parseGit(c.args).sub : '';
  const gh = c.cmd === 'gh' ? `${c.args[0]} ${c.args[1] ?? ''}` : '';
  if (/^(commit|push|merge|rebase|tag|cherry-pick|am|revert)$/.test(git) || /^pr (merge|comment|review|edit|close|create|ready)|^issue (comment|create|edit)|^api /.test(gh) && !(gh.startsWith('api ') && !hasWriteFields(c.args))) {
    return `The ${agent} agent judges and reproduces; it does not commit, push or post. Report the finding in your final message; the hook posts it.`;
  }
  return null;
}

// --- git ------------------------------------------------------------------------------------------
function gitRule(c, cwd, deps) {
  const { dir, sub, rest } = parseGit(c.args);
  const repo = dir ? path.resolve(cwd, dir) : cwd;
  if (rest.includes('--no-verify') || (sub === 'commit' && rest.some(a => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--')))) {
    return 'Do not skip git hooks (--no-verify / -n). Fix what the hook reports; it is part of the safety net.';
  }
  if (sub === 'push') return pushRule(rest, repo, deps);
  if (sub === 'rebase' && !rest.some(a => /^--(abort|continue|skip|quit|edit-todo|show-current-patch)$/.test(a))) return rebaseRule(repo, deps);
  if (sub === 'pull' && rest.some(a => a === '--rebase' || a === '-r' || a.startsWith('--rebase='))) return rebaseRule(repo, deps);
  return null;
}

const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushRule(rest, repo, deps) {
  const flags = [];
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('-')) flags.push(a); else positional.push(a);
  }
  if (flags.some(f => f === '--all' || f === '--mirror' || f === '--branches')) {
    return 'Push one branch at a time (no --all/--mirror), so the default branch only changes through a merged PR.';
  }
  const lease = flags.some(f => f.startsWith('--force-with-lease'));
  const force = flags.some(f => f === '--force' || f === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || positional.slice(1).some(r => r.startsWith('+'));
  if (force && !lease) {
    return 'Plain force-push can destroy commits. If you must rewrite your own unshared branch, use --force-with-lease; on a shared branch, merge instead.';
  }
  const refspecs = positional.slice(1);
  const current = () => { try { return deps.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return ''; } };
  const targets = refspecs.length ? refspecs.map(r => {
    let dst = r.includes(':') ? r.split(':').pop() : r;
    dst = dst.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    return dst === 'HEAD' || dst === '' ? (r.startsWith(':') ? r.slice(1) : current()) : dst;
  }) : [current()];
  if (flags.includes('--delete') || flags.includes('-d')) {
    return targets.some(t => DEFAULT_BRANCH.test(t)) ? 'Never delete the default branch.' : null;
  }
  const hit = targets.find(t => DEFAULT_BRANCH.test(t));
  if (hit) {
    return `Direct push to ${hit} is blocked. Push a branch and open a PR: git switch -c <type>/<topic>, git push -u origin HEAD, gh pr create.`;
  }
  return null;
}

function rebaseRule(repo, deps) {
  let branch = '';
  let upstream = '';
  try {
    branch = deps.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    upstream = deps.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  } catch { return null; }
  if (upstream && upstream.split('/').slice(1).join('/') === branch) {
    return `${branch} is already pushed, so rebasing rewrites shared history. Merge the default branch into it instead, and only when GitHub reports a conflict (each merge-in needs a new verdict).`;
  }
  return null;
}

// --- gh -------------------------------------------------------------------------------------------
function ghRule(c, cwd, deps) {
  const [group, action] = c.args;
  if (group === 'pr' && action === 'merge') return mergeGate(c.args.slice(2), cwd, deps);
  if (group === 'api') return apiRule(c.args.slice(1));
  return null;
}

function hasWriteFields(args) {
  return args.some(a => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^--(field|raw-field|input)=/.test(a)) ||
    args.some((a, i) => (a === '-X' || a === '--method') && !/^GET$/i.test(args[i + 1] ?? '')) ||
    args.some(a => /^--method=(?!GET$)/i.test(a));
}

const API_VALUE_OPTS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

function apiRule(args) {
  let endpoint = '';
  for (let i = 0; i < args.length; i++) {
    if (API_VALUE_OPTS.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) { endpoint = args[i]; break; }
  }
  const writes = hasWriteFields(args);
  const text = args.join(' ');
  if (endpoint === 'graphql' && /mergePullRequest|enablePullRequestAutoMerge|updateRef|deleteRef|createCommitOnBranch/.test(text)) {
    return 'Merging or moving refs through GraphQL skips the bstack gate. Use gh pr merge <n> --squash --delete-branch.';
  }
  if (!writes) return null;
  if (/\/pulls\/\d+\/merge\b|\/merges\b/.test(endpoint)) return 'Merging through gh api skips the bstack gate. Use gh pr merge <n> --squash --delete-branch.';
  if (/git\/refs\/heads\/(main|master)\b/.test(endpoint)) return 'Moving the default branch through gh api is blocked. Land changes through a PR.';
  if (/\/contents\//.test(endpoint) && !args.some(a => /^branch=(?!main$|master$)/.test(a))) {
    return 'Writing files through the contents API commits straight to the default branch. Commit on a branch and open a PR.';
  }
  return null;
}

const MERGE_VALUE_OPTS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email']);

function mergeGate(args, cwd, deps) {
  const flags = [];
  let selector = null;
  let repo = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MERGE_VALUE_OPTS.has(a)) { if (a === '-R' || a === '--repo') repo = args[i + 1]; i++; continue; }
    if (a.startsWith('--repo=')) { repo = a.slice(7); continue; }
    if (a.startsWith('-')) flags.push(a); else selector ??= a;
  }
  if (flags.includes('--auto')) return 'Auto-merge is blocked: it would merge later without the verdict check. Wait for CI and the verdict, then gh pr merge <n> --squash --delete-branch.';
  if (flags.includes('--admin')) return '--admin bypasses the repo rules. Merge normally once CI and the verdict are in.';
  if (!flags.some(f => f === '--squash' || f === '-s')) return 'Squash merge only: gh pr merge <n> --squash --delete-branch.';

  const target = [...(selector ? [selector] : []), ...(repo ? ['-R', repo] : [])];
  let pr;
  try {
    pr = JSON.parse(deps.gh(cwd, ['pr', 'view', ...target, '--json', 'number,url,headRefOid,state,statusCheckRollup,comments']));
  } catch (e) {
    return `bstack could not read the PR to check the merge gate (${String(e.message ?? e).split('\n')[0]}). Fix that and retry; the gate fails closed.`;
  }
  if (pr.state && pr.state !== 'OPEN') return null;
  const sha = pr.headRefOid;
  const short = sha.slice(0, 7);

  const ci = ciState(pr.statusCheckRollup);
  if (!ci.ok) return `CI is not green on ${short}: ${ci.detail}. Watch it with gh pr checks ${pr.number} --watch. Flaky: rerun once. Caused by the change: fix it. Never weaken the check.`;

  let diff;
  try { diff = deps.gh(cwd, ['pr', 'diff', String(pr.number), ...(repo ? ['-R', repo] : [])]); }
  catch (e) { return `bstack could not read the PR diff to compute the risk tier (${String(e.message ?? e).split('\n')[0]}). The gate fails closed.`; }
  const risk = riskTier(diff, { extraPaths: readRiskPaths(cwd) });
  if (risk.tier === 0) return null;

  const why = risk.reasons.length ? ` (${risk.reasons.slice(0, 3).join('; ')})` : '';
  const verdict = latestFor('verdict', pr.comments, sha);
  if (!verdict) return `Tier ${risk.tier}${why}: no reviewer verdict for head ${short}. Run the bstack:reviewer agent on PR ${pr.number}; its hook posts the verdict.`;
  if (verdict.result === 'FAIL') return `The latest verdict for ${short} is FAIL. Fix it in a fresh round, push, and run bstack:reviewer again.`;
  if (risk.tier === 2) {
    const inter = latestFor('interrogate', pr.comments, sha);
    if (!inter) return `Tier 2${why}: run bstack:interrogate on head ${short} before merging, and get the user's OK if a revert cannot undo it.`;
    if (inter.confirmed > 0) return `Interrogate confirmed ${inter.confirmed} finding(s) on ${short}. Fix them through the bug-fix playbook, then review again.`;
  }
  return null;
}

export function ciState(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return { ok: false, detail: 'no checks ran (a missing check is not a pass)' };
  const pending = [];
  const failed = [];
  let ran = 0;
  for (const c of checks) {
    const name = c.name ?? c.context ?? 'check';
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      if (c.state === 'SUCCESS') ran++;
      else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending.push(name);
      else failed.push(name);
      continue;
    }
    if (c.status !== 'COMPLETED') { pending.push(name); continue; }
    if (c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL') ran++;
    else if (c.conclusion !== 'SKIPPED') failed.push(name);
  }
  if (failed.length) return { ok: false, detail: `failed: ${failed.join(', ')}` };
  if (pending.length) return { ok: false, detail: `still running: ${pending.join(', ')}` };
  if (!ran) return { ok: false, detail: 'every check was skipped' };
  return { ok: true };
}

// --- MCP and file writes ----------------------------------------------------------------------------
function mcpRule(tool, input) {
  if (/merge/i.test(tool) && /(pull|_pr|pr_)/i.test(tool)) return 'Merging through an MCP tool skips the bstack gate. Use gh pr merge <n> --squash --delete-branch.';
  if (/(push_files|create_or_update_file|delete_file|update_ref|create_commit)/i.test(tool) && DEFAULT_BRANCH.test(String(input.branch ?? input.ref ?? 'main').replace(/^refs\/heads\//, ''))) {
    return 'Writing to the default branch through an MCP tool is blocked. Commit on a branch and open a PR.';
  }
  return null;
}

function writeRule(input, deps) {
  const text = [input.content, input.new_string, input.new_source, ...(input.edits ?? []).map(e => e.new_string)].filter(Boolean).join('\n');
  if (!MARKER.test(text)) return null;
  const file = String(input.file_path ?? input.notebook_path ?? '');
  if (deps.insideBstackSource(file)) return null;
  return 'Files must not carry bstack verdict lines: verdicts are posted only by the bstack hook.';
}

// --- wiring -----------------------------------------------------------------------------------------
export const realDeps = {
  git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }),
  gh: (cwd, args) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 64 << 20 }),
  readFile: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
  insideBstackSource: file => {
    let dir = path.dirname(path.resolve(file));
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(dir, 'plugins', 'bstack', '.claude-plugin', 'plugin.json'))) return true;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return false;
  },
};

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const reason = decide(input, realDeps);
  if (reason) {
    process.stderr.write(`bstack guard: ${reason}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`bstack guard failed: ${e.stack ?? e}\n`); process.exit(2); });
}
