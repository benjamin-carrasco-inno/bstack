#!/usr/bin/env node
// PreToolUse guard for Bash, PowerShell, file writes and MCP tools. It blocks what a rule in prose
// cannot hold: pushes to the default branch, skipped hooks, force-pushes, rebasing pushed branches,
// merges without green CI and a reviewer verdict for the head SHA, merges through side doors
// (gh api, MCP), forged verdicts, and commits that add comment lines over a repo's comment baseline.
// Exit 2 with a message that names the right alternative.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSIGNMENT, UNRESOLVED, commandsIn, endsInRedirect, parseGit, redirectTargets, tokenize, withoutHeredocBodies } from './lib/shell.mjs';
import { KINDS, MARKER, latestFor, timeOf } from './lib/verdicts.mjs';
import { PENDING_NAME, pendingStore, repoOfUrl } from './lib/pending.mjs';
import { commentRatchet } from './lib/ratchet.mjs';
import { contains, isAbsolute, resolvePath } from './lib/paths.mjs';
import { riskTier, readRiskPaths } from './risk-tier.mjs';

const DEFAULT_BRANCH = /^(main|master)$/;
const READ_ONLY = new Set(['grep', 'rg', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content', 'gc', 'jq', 'less', 'head', 'tail', 'wc']);
const NO_AUTHORING_AGENTS = /(^|:)(reviewer|adversary|comment-critic)$/;

export function decide(input, deps) {
  const tool = String(input.tool_name ?? '');
  const cwd = input.cwd || process.cwd();
  const agent = String(input.agent_type ?? '');
  if (tool.startsWith('mcp__')) return mcpRule(tool, input.tool_input ?? {});
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return writeRule(input.tool_input ?? {}, deps);
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const line = String(input.tool_input?.command ?? '');
  const dialect = tool === 'PowerShell' ? 'powershell' : 'posix';
  const host = deps.host ?? REAL_HOST;
  const root = resolvePath(cwd);
  const commands = located(commandsIn(line, 0, dialect), cwd, host);
  for (const [k, c] of commands.entries()) {
    const reason = markerRule(c, cwd, deps) ?? agentRule(c, agent) ?? (c.cmd === 'git' ? gitRule(c, cwd, deps, { tool, prior: commands.slice(0, k) }) : null) ?? (c.cmd === 'gh' ? ghRule(c, cwd, deps) : null);
    if (reason) return reason;
  }
  return agentWritesRule(line, dialect, cwd, agent, root, host);
}

const REAL_HOST = { platform: process.platform, env: process.env, tmpdir: () => os.tmpdir() };

const DIR_MOVES = {
  cd: 'go', chdir: 'go', 'set-location': 'go', sl: 'go',
  pushd: 'push', 'push-location': 'push',
  popd: 'pop', 'pop-location': 'pop',
};
const HOME = /^~(?=$|[\\/])/;
const OPAQUE = /[$`]|%[^%\s]+%/;
const GIT_LOCATION_VARIABLE = /^GIT_(DIR|WORK_TREE)$/i;
const TEMP_PREFIX = {
  posix: /^(?:\/tmp|\$\{?(?<name>TMPDIR|TEMP|TMP)\}?)(?=$|\/)/,
  powershell: /^\$env:(?<name>TEMP|TMP)(?=$|[\\/])/i,
};

const UNKNOWN_DIR = null;
const PS_ENV = /^\$env:([A-Za-z_]\w*)\s*=\s*(.*)$/is;

function inTempDir(word, dialect, host, assigned) {
  const prefix = TEMP_PREFIX[dialect]?.exec(word ?? '');
  if (!prefix) return { word, dialect };
  const name = prefix.groups.name?.toUpperCase();
  if (name && Object.keys(assigned).some(k => k.toUpperCase() === name)) return { word, dialect };
  const dir = host.platform === 'win32' ? host.tmpdir() : name && host.env[name];
  if (!dir) return { word, dialect };
  return { word: dir + word.slice(prefix[0].length), dialect: 'posix' };
}

function located(commands, start, host) {
  const scopes = new Map();
  return commands.map(c => {
    const shell = shellState(scopes, c.scope ?? '', start);
    const at = { ...c, cwd: shell.here.dir, cwdKnown: shell.here.known, env: { ...shell.env, ...c.env } };
    changeDir(shell, c, host);
    setVariables(shell.env, c);
    return at;
  });
}

function shellState(scopes, scope, start) {
  if (!scopes.has(scope)) {
    const parent = scope ? shellState(scopes, scope.slice(0, scope.lastIndexOf('/')), start) : { here: { dir: start, known: true }, previous: undefined, stack: [], env: {} };
    scopes.set(scope, { ...parent, stack: [...parent.stack], env: { ...parent.env } });
  }
  return scopes.get(scope);
}

function changeDir(shell, c, host) {
  const move = DIR_MOVES[c.cmd];
  const at = c.args.findIndex(a => a === '-' || (!a.startsWith('-') && !/^\/d$/i.test(a)));
  const { word: target, dialect } = inTempDir(c.args[at], c.dialect, host, shell.env);
  if (move === 'pop') {
    if (shell.stack.length) [shell.previous, shell.here] = [shell.here, shell.stack.pop()];
  } else if (move && target === '-') {
    if (shell.previous !== undefined) [shell.previous, shell.here] = [shell.here, shell.previous];
  } else if (move) {
    if (move === 'push') shell.stack.push(shell.here);
    shell.previous = shell.here;
    const dir = resolvedDir(target, shell.here.dir, dialect);
    const opaque = target === undefined || c.expressions?.has(at) || OPAQUE.test(target) || HOME.test(target);
    shell.here = { dir, known: dir !== UNKNOWN_DIR && !opaque && (shell.here.known || isAbsolute(target, dialect)) };
  }
}

function setVariables(env, c) {
  if (c.cmd === '') Object.assign(env, c.env);
  if (c.cmd === 'export' || (c.cmd === 'set' && c.dialect === 'cmd')) {
    for (const set of c.args.map(a => ASSIGNMENT.exec(a)).filter(Boolean)) env[set[1]] = set[2];
  }
  const ps = PS_ENV.exec(c.text);
  if (ps) {
    const value = tokenize(ps[2]);
    env[ps[1].toUpperCase()] = value.length === 1 ? value[0] : '$';
  }
}

function resolvedDir(target, here, dialect) {
  if (target === undefined) return here;
  if (UNRESOLVED.test(target)) return UNKNOWN_DIR;
  const literal = target.replace(HOME, os.homedir());
  if (here === UNKNOWN_DIR && !isAbsolute(literal, dialect)) return UNKNOWN_DIR;
  return resolvePath(here ?? '', literal, dialect);
}

// --- verdict marker: only the SubagentStop hook writes it -------------------------------------
const SAVED_VERDICTS = 'Saved verdicts are written only by the bstack hook when GitHub does not answer; the guard posts them at the next merge. Run the bstack:reviewer or bstack:adversary agent instead.';

function markerRule(c, cwd, deps) {
  const readOnlyGh = c.cmd === 'gh' && (/^(view|checks|diff|list|status)$/.test(c.args[1] ?? '') || (c.args[0] === 'api' && !hasWriteFields(c.args)));
  if (MARKER.test(c.text) && !READ_ONLY.has(c.cmd) && !readOnlyGh) {
    return 'Verdict and interrogate lines are posted by the bstack hook when the bstack:reviewer or bstack:adversary agent finishes. Run that agent instead of writing the line yourself.';
  }
  if (!READ_ONLY.has(c.cmd) && pathArgs(c).some(a => PENDING_PATH.test(a))) return SAVED_VERDICTS;
  if (c.cmd === 'gh') {
    for (const file of bodyFiles(c.args)) {
      const text = deps.readFile(resolvePath(cwd, file, c.dialect));
      if (text && MARKER.test(text)) return `The body file ${file} contains a bstack verdict line. Verdicts are posted only by the bstack hook.`;
    }
  }
  return null;
}

const PENDING_PATH = new RegExp(String.raw`(^|[\\/>=])${PENDING_NAME.source}([\\/]|$)`, 'i');
const MESSAGE_OPTS = new Set(['-m', '--message', '-b', '--body', '-t', '--title']);

function pathArgs({ cmd, args }) {
  if (cmd !== 'git' && cmd !== 'gh') return args;
  return args.filter((a, i) => !MESSAGE_OPTS.has(args[i - 1]) && !/^--(message|body|title)=/.test(a));
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

// --- reviewer, adversary and comment-critic judge; they never author ---------------------------------
function agentRule(c, agent) {
  if (!NO_AUTHORING_AGENTS.test(agent)) return null;
  const git = c.cmd === 'git' ? parseGit(c.args).sub : '';
  const gh = c.cmd === 'gh' ? `${c.args[0]} ${c.args[1] ?? ''}` : '';
  if (/^(commit|push|merge|rebase|tag|cherry-pick|am|revert)$/.test(git) || /^pr (merge|comment|review|edit|close|create|ready)|^issue (comment|create|edit|close|reopen|delete|transfer|lock|unlock|pin|unpin|develop)|^label (create|edit|delete|clone)|^api /.test(gh) && !(gh.startsWith('api ') && !hasWriteFields(c.args))) {
    return `The ${agent} agent judges and reproduces; it does not commit, push or post. Report the finding in your final message; the hook posts it.`;
  }
  return null;
}

function agentWritesRule(line, dialect, cwd, agent, root, host) {
  if (!NO_AUTHORING_AGENTS.test(agent)) return null;
  const commands = located(commandsIn(withoutHeredocBodies(line), 0, dialect), cwd, host);
  for (const [k, c] of commands.entries()) {
    const reason = treeRewriteRule(c, agent, root, host) ?? fileWriteRule(c, agent, root, commands[k + 1], host);
    if (reason) return reason;
  }
  return null;
}

const TREE_REWRITING_GIT = {
  stash: { rewrites: rest => !/^(list|show)$/.test(rest[0] ?? ''), anywhere: true },
  checkout: { rewrites: () => true },
  switch: { rewrites: () => true },
  worktree: { rewrites: rest => /^(add|remove|move|prune|repair)$/.test(rest[0] ?? ''), paths: rest => positionalArgs(rest.slice(1), /^(-b|-B|--reason)$/) },
  restore: { rewrites: () => true },
  reset: { rewrites: () => true },
  apply: { rewrites: rest => !rest.some(a => /^--(check|stat|numstat|summary)$/.test(a)) },
  clean: { rewrites: rest => !rest.some(a => a === '--dry-run' || /^-[a-zA-Z]*n/.test(a)) },
  rm: { rewrites: () => true },
  mv: { rewrites: () => true },
  pull: { rewrites: () => true },
  'read-tree': { rewrites: () => true },
  'checkout-index': { rewrites: () => true },
  'update-index': { rewrites: () => true },
};
const UNKNOWN_GIT = { rewrites: () => true };
const GIT_BUILTINS = new Set(`add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore
  check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone commit commit-graph commit-tree config
  count-objects describe diagnose diff diff-files diff-index diff-tree difftool fetch fetch-pack for-each-ref for-each-repo
  format-patch fsck gc get-tar-commit-id grep hash-object help init interpret-trailers log ls-files ls-remote ls-tree
  maintenance merge merge-base merge-file merge-tree mktag mktree mv name-rev notes pack-objects pack-refs prune pull push
  range-diff read-tree rebase reflog remote repack replace rerere reset restore rev-list rev-parse revert rm shortlog show
  show-branch show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var
  verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/));

function treeRewriteRule(c, agent, root, host) {
  if (c.cmd !== 'git') return null;
  const { dir, dirExpression, aliases, sub, rest } = parseGit(c.args, c.expressions);
  if (aliases) return `The ${agent} agent must not define git aliases on the command line: an alias can run any command, also on another checkout. Run the git command itself.`;
  const rule = TREE_REWRITING_GIT[sub] ?? (sub && !GIT_BUILTINS.has(sub) ? UNKNOWN_GIT : null);
  if (!rule?.rewrites(rest)) return null;
  if (rule.anywhere) return `The ${agent} agent must not run git ${sub}: the stash stack is shared by every worktree of the repo. Read with git stash list or git stash show.`;
  const otherTree = Object.keys(c.env).some(name => GIT_LOCATION_VARIABLE.test(name)) || c.args.some(a => /^--(work-tree|git-dir)\b/.test(a));
  const here = knownCwd(c);
  const repo = !dir ? here : dirExpression ? undefined : writeTarget(dir, here, c.dialect, host, c.env, false);
  const touched = [repo, ...(rule.paths?.(rest) ?? []).map(p => repo && writeTarget(p, repo, c.dialect, host, c.env))];
  if (otherTree || touched.some(p => !p || !owns(root, p, host))) return `The ${agent} agent must not run git ${sub} on a checkout outside its own worktree (${root}), or one the guard cannot locate; it would rewrite someone else's uncommitted work. Read with git diff or git show instead.`;
  return null;
}

function knownCwd(c) {
  return c.cwdKnown ? c.cwd : undefined;
}

const PATH_NAMES = ['path', 'literalpath', 'lp', 'pspath'];
const POWERSHELL_SWITCHES = ['force', 'nonewline', 'passthru', 'append', 'noclobber', 'whatif', 'confirm', 'asbytestream', 'recurse'];
const byArgs = spec => (args, dialect) => writeTargets(args, spec, dialect);
const REMOVES = byArgs({ pick: 'all', named: PATH_NAMES });
const MOVES = byArgs({ pick: 'all', named: [...PATH_NAMES, 'destination'] });
const COPIES_BY_ARGS = byArgs({ pick: 'last', named: ['destination'] });
const COPIES = (args, dialect) => {
  const dirs = targetDirectories(args);
  return dirs.length ? dirs : COPIES_BY_ARGS(args, dialect);
};
const WRITES_CONTENT = byArgs({ pick: 'first', named: [...PATH_NAMES, 'filepath'], valued: true });
const WINDOWS_COPIES = args => {
  const paths = args.filter(a => !/^\/[a-z?]+(:.*)?$/i.test(a));
  return [paths[1] ?? '.'];
};

const FILE_WRITERS = {
  sed: sedInPlaceTargets,
  tee: byArgs({ pick: 'all', named: [] }),
  rm: REMOVES, 'remove-item': REMOVES, ri: REMOVES, del: REMOVES, erase: REMOVES, rmdir: REMOVES, rd: REMOVES,
  'clear-content': REMOVES, clc: REMOVES, mkdir: REMOVES, md: REMOVES,
  mv: MOVES, 'move-item': MOVES, mi: MOVES, move: MOVES, 'rename-item': MOVES, rni: MOVES, ren: MOVES,
  cp: COPIES, 'copy-item': COPIES, cpi: COPIES, copy: COPIES,
  xcopy: WINDOWS_COPIES, robocopy: WINDOWS_COPIES,
  'set-content': WRITES_CONTENT, sc: WRITES_CONTENT, 'add-content': WRITES_CONTENT, ac: WRITES_CONTENT,
  'out-file': WRITES_CONTENT, 'tee-object': WRITES_CONTENT, 'new-item': WRITES_CONTENT, ni: WRITES_CONTENT,
  dd: args => args.filter(a => a.startsWith('of=')).map(a => a.slice(3)),
  truncate: args => positionalArgs(args, /^(-s|-r|--size|--reference)$/),
  ln: linkTargets,
  curl: args => optionValues(args, /^(-[a-zA-Z]*o|--output|--output-dir)$/, /^--output(-dir)?=/),
  patch: patchTargets,
};

function positionalArgs(args, valued) {
  return args.filter((a, i) => !a.startsWith('-') && !valued.test(args[i - 1] ?? ''));
}

function optionValues(args, separate, glued) {
  return args.flatMap((a, i) => separate.test(a) ? [args[i + 1]] : glued.test(a) ? [a.slice(a.indexOf('=') + 1)] : []).filter(Boolean);
}

function targetDirectories(args) {
  return optionValues(args, /^(-t|--target-directory)$/, /^--target-directory=/);
}

function linkTargets(args) {
  const named = targetDirectories(args);
  if (named.length) return named;
  const positional = positionalArgs(args, /^(-t|--target-directory|-S|--suffix)$/);
  return positional.length > 1 ? positional.slice(-1) : [];
}

const PATCH_VALUED = /^(-[pidoDBFrzVYg]|--(strip|input|output|directory|reject-file|prefix|suffix|basename-prefix|fuzz|backup-if-mismatch|version-control|get))$/;

function patchTargets(args) {
  const words = args.filter((a, i) => !a.startsWith('<') && args[i - 1] !== '<');
  const named = optionValues(words, /^(-[dor]|--(directory|output|reject-file))$/, /^--(directory|output|reject-file)=/);
  const [original] = positionalArgs(words, PATCH_VALUED);
  return [...named, original ?? '.'];
}

const DOTNET_FILE_WRITE = /\[(System\.)?IO\.File\]::(Write|Append)\w*\s*\(\s*(?:(['"])(.*?)\3|([^,\s)]+))/gi;

function dotnetWriteTargets(text) {
  return [...text.matchAll(DOTNET_FILE_WRITE)].map(m => m[4] ?? m[5]);
}

function namesParameter(flag, names, dialect) {
  const name = /^-([a-z]+)$/i.exec(flag)?.[1].toLowerCase();
  if (!name) return false;
  return names.some(n => (dialect === 'powershell' ? n.startsWith(name) : n === name));
}

function writeTargets(args, { pick, named, valued = false }, dialect) {
  const byName = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const inline = /^(-[a-z]+):(.+)$/i.exec(a);
    if (inline) { if (namesParameter(inline[1], named, dialect)) byName.push(inline[2]); continue; }
    if (namesParameter(a, named, dialect)) { if (i + 1 < args.length) byName.push(args[++i]); continue; }
    if (/^-./.test(a) || /^\/[a-z]$/i.test(a)) { if (valued && !namesParameter(a, POWERSHELL_SWITCHES, dialect)) i++; continue; }
    positional.push(a);
  }
  if (byName.length && pick !== 'all') return byName;
  return [...byName, ...{ first: positional.slice(0, 1), last: positional.slice(-1), all: positional }[pick]];
}

function sedInPlaceTargets(args) {
  if (!args.some(a => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) return [];
  const positional = [];
  let scriptGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(-e|-f|--expression|--file)$/.test(a)) { scriptGiven = true; i++; continue; }
    if (/^--(expression|file)=/.test(a)) { scriptGiven = true; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  return scriptGiven ? positional : positional.slice(1);
}

const NULL_SINK = /^(\$null|\/dev\/(null|stdout|stderr)|nul)$/i;

const PARENT_SEGMENT = /(^|[\\/])\.\.($|[\\/])/;

function hidesParent(word) {
  return PARENT_SEGMENT.test(word.replace(/\\(.)/g, '$1')) && !PARENT_SEGMENT.test(word);
}

function writeTarget(word, cwd, shellDialect, host, assigned, expression = word.includes('(')) {
  if (NULL_SINK.test(word)) return null;
  const { word: inTemp, dialect } = inTempDir(word, shellDialect, host, assigned);
  const expanded = inTemp.replace(HOME, os.homedir());
  if (expression || OPAQUE.test(expanded) || hidesParent(expanded)) return undefined;
  if (cwd === undefined && !isAbsolute(expanded, dialect)) return undefined;
  return resolvePath(cwd, expanded, dialect);
}

function owns(root, target, host) {
  return [root, resolvePath(host.tmpdir())].some(dir => contains(dir, target));
}

function fileWriteRule(c, agent, root, next, host) {
  const clobbered = next && endsInRedirect(c.text, c.dialect) ? tokenize(next.text).slice(0, 1) : [];
  const words = [...redirectTargets(c.text), ...clobbered,...dotnetWriteTargets(c.text), ...(FILE_WRITERS[c.cmd]?.(c.args, c.dialect) ?? [])];
  for (const word of words) {
    const target = writeTarget(word, knownCwd(c), c.dialect, host, c.env);
    if (target === null) continue;
    if (target === undefined) return `The ${agent} agent may write files only inside its own worktree or the temp dir, and ${word} cannot be resolved before it runs. Use a literal path.`;
    if (!owns(root, target, host)) return `The ${agent} agent may write files only inside its own worktree (${root}) or the temp dir, not ${target}. Report what should change instead of changing it.`;
  }
  return null;
}

// --- git ------------------------------------------------------------------------------------------
const CONCLUDES_WITH_COMMIT = /^(merge|cherry-pick|revert|rebase)$/;

function gitRule(c, cwd, deps, line) {
  const { dir, dirKnown, sub, rest } = parseGit(c.args, c.expressions);
  const repo = !dirKnown ? UNKNOWN_DIR : dir ? resolvePath(cwd, dir, c.dialect) : cwd;
  if (rest.includes('--no-verify') || (sub === 'commit' && rest.some(a => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--')))) {
    return 'Do not skip git hooks (--no-verify / -n). Fix what the hook reports; it is part of the safety net.';
  }
  if (sub === 'commit') return commentRatchet({ command: c, rest, ...line }, deps);
  if (CONCLUDES_WITH_COMMIT.test(sub) && rest.includes('--continue')) return commentRatchet({ command: c, rest: [], ...line }, deps);
  if (sub === 'push') return pushRule(rest, repo, deps);
  if (sub === 'rebase' && !rest.some(a => /^--(abort|continue|skip|quit|edit-todo|show-current-patch)$/.test(a))) return rebaseRule(repo, deps);
  if (sub === 'pull' && rest.some(a => a === '--rebase' || a === '-r' || a.startsWith('--rebase='))) return rebaseRule(repo, deps);
  return null;
}

const UNKNOWN_BRANCH = null;
const PUSH_VALUE_OPTS =new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

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
  const current = () => {
    if (repo === UNKNOWN_DIR) return UNKNOWN_BRANCH;
    try { return deps.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return ''; }
  };
  const targets = refspecs.length ? refspecs.map(r => {
    let dst = r.includes(':') ? r.split(':').pop() : r;
    dst = dst.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    return dst === 'HEAD' || dst === '' ? (r.startsWith(':') ? r.slice(1) : current()) : dst;
  }) : [current()];
  if (targets.includes(UNKNOWN_BRANCH)) return unlocatedRepo('which branch this push sends');
  if (flags.includes('--delete') || flags.includes('-d')) {
    return targets.some(t => DEFAULT_BRANCH.test(t)) ? 'Never delete the default branch.' : null;
  }
  const hit = targets.find(t => DEFAULT_BRANCH.test(t));
  if (hit) {
    return `Direct push to ${hit} is blocked. Push a branch and open a PR: git switch -c <type>/<topic>, git push -u origin HEAD, gh pr create.`;
  }
  return null;
}

function unlocatedRepo(what) {
  return `bstack cannot tell ${what}: the git -C path is not literal, so the guard cannot locate the repository. Write the path out, or cd there in its own call.`;
}

function rebaseRule(repo, deps) {
  if (repo === UNKNOWN_DIR) return unlocatedRepo('whether this rebase rewrites a pushed branch');
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
  if (repo && /[$%]/.test(repo)) return `The guard cannot see what ${repo} holds, so it cannot read the verdict from that repository. Write the repository out: gh pr merge <n> -R owner/repo --squash --delete-branch.`;

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
  const unposted = postSaved(pr, cwd, deps);
  if (unposted) return unposted;

  const ci = ciState(pr.statusCheckRollup);
  if (!ci.ok) return `CI is not green on ${short}: ${ci.detail}. Watch it with gh pr checks ${pr.url} --watch. Flaky: rerun once. Caused by the change: fix it. Never weaken the check.`;

  let diff;
  try { diff = deps.gh(cwd, ['pr', 'diff', pr.url, ...(repo ? ['-R', repo] : [])]); }
  catch (e) { return `bstack could not read the PR diff to compute the risk tier (${String(e.message ?? e).split('\n')[0]}). The gate fails closed.`; }
  const risk = riskTier(diff, { extraPaths: readRiskPaths(cwd) });
  if (risk.tier === 0) return null;

  const why = risk.reasons.length ? ` (${risk.reasons.slice(0, 3).join('; ')})` : '';
  const verdict = latestFor('verdict', pr.comments, sha);
  if (!verdict) return `Tier ${risk.tier}${why}: no reviewer verdict for head ${short}. Run the bstack:reviewer agent on ${pr.url}; its hook posts the verdict.`;
  if (verdict.result === 'FAIL') return `The latest verdict for ${short} is FAIL. Fix it in a fresh round, push, and run bstack:reviewer again.`;
  if (risk.tier === 2) {
    const inter = latestFor('interrogate', pr.comments, sha);
    if (!inter) return `Tier 2${why}: run bstack:interrogate on head ${short} before merging, and get the user's OK if a revert cannot undo it.`;
    if (inter.confirmed > 0) return `Interrogate confirmed ${inter.confirmed} finding(s) on ${short}. Fix them through the bug-fix playbook, then review again.`;
  }
  return null;
}

// Verdicts the hook saved while GitHub did not answer: post the ones for this head, drop older heads,
// empty entries and entries a verdict of the same kind posted since then has replaced.
function postSaved(pr, cwd, deps) {
  const repo = repoOfUrl(pr.url);
  if (!repo) return null;
  pr.comments ??= [];
  for (const { file, entry } of deps.pending.list(repo, String(pr.number))) {
    const body = String(entry.body ?? '');
    if (entry.sha !== pr.headRefOid || !(entry.kind in KINDS) || !body.trim() || replaced(entry, pr.comments)) { deps.pending.remove(file); continue; }
    if (!pr.comments.some(c => String(c.body ?? '').trim() === body.trim())) {
      try { deps.postComment(cwd, pr.url, body); }
      catch (e) { return `bstack could not post the ${entry.kind} it saved for ${pr.headRefOid.slice(0, 7)} (${String(e.message ?? e).split('\n')[0]}). Retry the merge; the gate fails closed.`; }
      pr.comments.push({ body, createdAt: new Date().toISOString() });
    }
    deps.pending.remove(file);
  }
  return null;
}

function replaced(entry, comments) {
  const { tag, line } = KINDS[entry.kind];
  const savedAt = Date.parse(entry.at ?? '') || 0;
  return comments.some(c => {
    const body = String(c.body ?? '');
    return body.startsWith(tag) && line.exec(body)?.[2] === entry.sha && timeOf(c) > savedAt;
  });
}

const runKey = c => `${c.__typename ?? ''}|${c.workflowName ?? ''}|${c.name ?? c.context ?? 'check'}`;
const NEVER_STARTED = /^0001-01-01/;
const startTime = c => (!c.startedAt || NEVER_STARTED.test(c.startedAt) ? Infinity : Date.parse(c.startedAt) || Infinity);

const replacedBySuccess = (c, checks) =>
  c.conclusion === 'CANCELLED' &&
  checks.some(o => runKey(o) === runKey(c) && o.conclusion === 'SUCCESS' && startTime(o) > startTime(c));

export function ciState(rollup) {
  const all = Array.isArray(rollup) ? rollup : [];
  const checks = all.filter(c => !replacedBySuccess(c, all));
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
  if (PENDING_NAME.test(String(input.file_path ?? input.notebook_path ?? ''))) return SAVED_VERDICTS;
  const text = [input.content, input.new_string, input.new_source, ...(input.edits ?? []).map(e => e.new_string)].filter(Boolean).join('\n');
  if (!MARKER.test(text)) return null;
  const file = String(input.file_path ?? input.notebook_path ?? '');
  if (deps.insideBstackSource(file)) return null;
  return 'Files must not carry bstack verdict lines: verdicts are posted only by the bstack hook.';
}

// --- wiring -----------------------------------------------------------------------------------------
// hooks.json gives the shell guard 300 s: the PR read, the diff and one saved-verdict post at 30 + 60 s each.
export function retryOnTimeout(run, timeouts = [30000, 60000]) {
  return (cwd, args) => {
    try {
      return run(cwd, args, timeouts[0]);
    } catch (e) {
      if (e?.code !== 'ETIMEDOUT') throw e;
      return run(cwd, args, timeouts[1]);
    }
  };
}

const gh = retryOnTimeout((cwd, args, timeout) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 << 20 }));

export const realDeps = {
  git: (cwd, args, { env, input, buffer, timeout = 15000 } = {}) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: buffer ? undefined : 'utf8', input, env: env ? { ...process.env, ...env } : undefined, timeout, maxBuffer: 256 << 20,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }),
  gh,
  pending: pendingStore(),
  postComment: (cwd, url, body) => {
    const file = path.join(os.tmpdir(), `bstack-saved-verdict-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(file, body, 'utf8');
    try { gh(cwd, ['pr', 'comment', url, '--body-file', file]); } finally { fs.rmSync(file, { force: true }); }
  },
  exists: file => fs.existsSync(file),
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
