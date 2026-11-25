#!/usr/bin/env node
// PreToolUse guard for Bash, PowerShell, file writes and MCP tools. It blocks what a rule in prose
// cannot hold: pushes to the default branch, skipped hooks, force-pushes, rebasing pushed branches,
// merges without green CI and a reviewer verdict for the head SHA (or one carried across merge-ins
// of the base branch that left the PR diff unchanged), merges through side doors
// (gh api, MCP), forged verdicts, and commits that add comment lines over a repo's comment baseline.
// Exit 2 with a message that names the right alternative.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSIGNMENT, UNRESOLVED, closingBacktick, closingParen, commandsIn, endsInRedirect, loopBodies, parseGit, redirectTargets, tokenize, withoutHeredocBodies, words } from './lib/shell.mjs';
import { INTERROGATE_ROUNDS, KINDS, MARKER, blockingRounds, latestFor, shaOf, timeOf, userOkFor } from './lib/verdicts.mjs';
import { PENDING_NAME, pendingStore, repoOfUrl } from './lib/pending.mjs';
import { commentRatchet } from './lib/ratchet.mjs';
import { pathsOn } from './lib/paths.mjs';
import { prMergeInChain, sameChange } from './lib/carry.mjs';
import { policyLines, readBasePolicy } from './lib/base-policy.mjs';
import { RISK_PATHS, ghFileReader, riskTier, tierZeroDocs } from './risk-tier.mjs';

const DEFAULT_BRANCH = /^(main|master)$/;
const READ_ONLY = new Set(['grep', 'rg', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content', 'gc', 'jq', 'less', 'head', 'tail', 'wc']);
const NO_AUTHORING_AGENTS = /(^|:)(reviewer|adversary|comment-critic)$/;

export function decide(input, deps) {
  const tool = String(input.tool_name ?? '');
  const cwd = input.cwd || process.cwd();
  const agent = String(input.agent_type ?? '');
  if (tool.startsWith('mcp__')) return mcpRule(tool, input.tool_input ?? {});
  const host = withPaths(deps.host ?? REAL_HOST);
  const root = host.paths.resolvePath(cwd);
  const noAuthoring = NO_AUTHORING_AGENTS.test(agent);
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return (noAuthoring ? agentFileRule(input.tool_input ?? {}, agent, root, host) : null) ?? writeRule(input.tool_input ?? {}, deps);
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const line = String(input.tool_input?.command ?? '');
  const dialect = tool === 'PowerShell' ? 'powershell' : 'posix';
  const tempNames = commandsIn(withoutHeredocBodies(line), 0, dialect).some(changesEnv) ? NO_TEMP_NAMES : plainTempNames(line);
  const hostDeps = { ...deps, host: { ...host, tempNames } };
  const refused = noAuthoring ? noAuthoringRule(line, dialect, cwd, agent, root, hostDeps.host) : null;
  if (refused) return refused;
  const commands = located(commandsIn(line, 0, dialect), cwd, { ...host, tempNames: NO_TEMP_NAMES });
  const looped = loopBodies(line).some(body => commandsIn(body, 0, dialect).some(createsCommit));
  for (const [k, c] of commands.entries()) {
    const reason = hiddenRule(c) ?? markerRule(c, hostDeps) ?? (c.cmd === 'git' ? gitRule(c, cwd, hostDeps, { tool, looped, prior: commands.slice(0, k) }) : null) ?? (c.cmd === 'gh' ? ghRule(c, cwd, hostDeps, line) : null);
    if (reason) return reason;
  }
  return null;
}

const REAL_HOST = { platform: process.platform, env: process.env, tmpdir: () => os.tmpdir() };
const withPaths = host => ({ ...host, paths: pathsOn(host.platform) });

const DIR_MOVES = {
  cd: 'go', chdir: 'go', 'set-location': 'go', sl: 'go',
  pushd: 'push', 'push-location': 'push',
  popd: 'pop', 'pop-location': 'pop',
};
const HOME = /^~(?=$|[\\/])/;
const OPAQUE = /[$`]|%[^%\s]+%/;
const TEMP_PREFIX = {
  posix: /^(?:\/tmp|\$\{?(?<name>TMPDIR|TEMP|TMP)\}?)(?=$|\/)/,
  powershell: /^\$env:(?<name>TEMP|TMP)(?=$|[\\/])/i,
};

const UNKNOWN_DIR = null;
const PS_ENV = /^\$env:([A-Za-z_]\w*)\s*=\s*(.*)$/is;

const TEMP_NAME_MENTION = /(?<![\w$])(?:\$\{|\$env:|\$)?(TMPDIR|TEMP|TMP)(?!\w)/gi;
const PLAIN_TEMP_READ = /^(?:\$\{\w+\}|\$(?:env:)?\w+)(?:\s*(?:$|[;|&\n])|['"\\/])/i;
const NO_TEMP_NAMES = new Set();

const ENV_CHANGERS = new Set(['.', 'source', 'eval', 'export', 'declare', 'typeset', 'local', 'readonly', 'read', 'unset', 'mapfile', 'readarray', 'let', 'getopts', 'for',
  'set', 'set-variable', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv', 'invoke-expression', 'iex', 'import-module', 'ipmo', 'add-type']);
const DYNAMIC_COMMAND = /[$`]|%[^%]+%/;
const POWERSHELL_SCRIPT = /\.psm?1$/;
const INVOKED_BY_PATH = /[\\/]|^\./;
const STATIC_MEMBER = /::/;
const LEADING_ENV_READ = /^\$(\{env:\w+\}|env:\w+)/i;
const REACHES_ENV_DRIVE = /env:|environment::|[$`]/i;
const LITERAL_ASSIGNMENT = /^\$(\{[^}]+\}|[\w:]+)\s*=\s*('[^']*'|"[^"$`]*"|[\w.\\/:-]+)$/;

function changesEnv(c) {
  if (c.dialect === 'powershell' && LITERAL_ASSIGNMENT.test(c.text)) return false;
  if (ENV_CHANGERS.has(c.cmd) || DYNAMIC_COMMAND.test(c.cmd) || POWERSHELL_SCRIPT.test(c.cmd)) return true;
  if (c.cmd === 'printf') return c.args.some(a => a.startsWith('-v'));
  if (c.dialect !== 'powershell') return false;
  if (STATIC_MEMBER.test(c.text)) return true;
  if (INVOKED_BY_PATH.test(c.program ?? '')) return true;
  const spec = POWERSHELL_PATH_TAKERS[POWERSHELL_PATH_TAKER_ALIASES[c.cmd] ?? c.cmd];
  const paths = spec ? writerTargets(c, spec) : [];
  return typeof paths === 'string' || paths.some(p => p.expression || REACHES_ENV_DRIVE.test(p.text.replace(LEADING_ENV_READ, '')));
}

function plainTempNames(line) {
  const mentions = [...line.matchAll(TEMP_NAME_MENTION)];
  const names = new Set(mentions.map(m => m[1].toUpperCase()));
  for (const m of mentions) {
    if (!PLAIN_TEMP_READ.test(line.slice(m.index))) names.delete(m[1].toUpperCase());
  }
  return names;
}

function inTempDir(word, dialect, host) {
  const prefix = TEMP_PREFIX[dialect]?.exec(word ?? '');
  if (!prefix) return { word, dialect };
  const name = prefix.groups.name?.toUpperCase();
  if (name && !host.tempNames?.has(name)) return { word, dialect };
  const dir = tempDirNamed(name, host);
  if (!dir) return { word, dialect };
  return { word: dir + word.slice(prefix[0].length), dialect: 'posix' };
}

function tempDirNamed(name, host) {
  if (host.platform !== 'win32') return name && host.env[name];
  return name === 'TMPDIR' ? host.env.TMPDIR : host.tmpdir();
}

function located(commands, start, host) {
  const scopes = new Map();
  const placed = new Map();
  return commands.map(c => {
    const shell = shellState(scopes, c.scope ?? '', start);
    const at = { ...c, cwd: shell.here.dir, cwdKnown: shell.here.known, env: { ...shell.env, ...c.env }, pipedFrom: placed.get(c.pipedFrom) ?? c.pipedFrom };
    placed.set(c, at);
    changeDir(shell, c, host);
    setVariables(shell.env, c);
    return at;
  });
}

function shellState(scopes, scope, start) {
  if (!scopes.has(scope)) {
    const parent = scope ? shellState(scopes, scope.slice(0, scope.lastIndexOf('/')), start) : { here: { dir: start, known: start !== UNKNOWN_DIR }, previous: undefined, stack: [], env: {} };
    scopes.set(scope, { ...parent, stack: [...parent.stack], env: { ...parent.env } });
  }
  return scopes.get(scope);
}

function changeDir(shell, c, host) {
  const move = DIR_MOVES[c.cmd];
  const at = c.args.findIndex(a => a === '-' || (!a.startsWith('-') && !/^\/d$/i.test(a)));
  const { word: target, dialect } = inTempDir(c.args[at], c.dialect, host);
  if (move === 'pop') {
    if (shell.stack.length) [shell.previous, shell.here] = [shell.here, shell.stack.pop()];
  } else if (move && target === '-') {
    if (shell.previous !== undefined) [shell.previous, shell.here] = [shell.here, shell.previous];
  } else if (move) {
    if (move === 'push') shell.stack.push(shell.here);
    shell.previous = shell.here;
    const dir = resolvedDir(target, shell.here.dir, dialect, host.paths);
    const opaque = target === undefined || c.expressions?.has(at) || OPAQUE.test(target) || HOME.test(target);
    shell.here = { dir, known: dir !== UNKNOWN_DIR && !opaque && (shell.here.known || host.paths.isAbsolute(target, dialect)) };
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

function resolvedDir(target, here, dialect, paths) {
  if (target === undefined) return here;
  if (UNRESOLVED.test(target)) return UNKNOWN_DIR;
  const literal = target.replace(HOME, os.homedir());
  if (here === UNKNOWN_DIR && !paths.isAbsolute(literal, dialect)) return UNKNOWN_DIR;
  return paths.resolvePath(here ?? '', literal, dialect);
}

function hiddenRule(c) {
  if (!c.hidden) return null;
  return `The guard cannot tell which command ${c.text.split(c.hidden)[0]}${c.hidden} runs, so it cannot check it. Drop the ${c.hidden} flag or run the command without the wrapper.`;
}

// --- verdict marker: only the SubagentStop hook writes it -------------------------------------
const MOVED_BODY = 'The guard does not follow the directory change of env -C, env --chdir, sudo -D or sudo --chdir, so it cannot see which file the gh body is read from. Run gh from the target directory with a literal path instead.';
const SAVED_VERDICTS = 'Saved verdicts are written only by the bstack hook when GitHub does not answer; the guard posts them at the next merge. Run the bstack:reviewer or bstack:adversary agent instead.';

function markerRule(c, deps) {
  const [ghGroup, ghAction] = c.cmd === 'gh' ? ghSubcommand(c.args) : [];
  const readOnlyGh = c.cmd === 'gh' && (/^(view|checks|diff|list|status)$/.test(ghAction ?? '') || (ghGroup === 'api' && !hasWriteFields(c.args)));
  if (MARKER.test(c.text) && !READ_ONLY.has(c.cmd) && !readOnlyGh) {
    return 'Verdict and interrogate lines are posted by the bstack hook when the bstack:reviewer or bstack:adversary agent finishes, and only the user writes the user-OK line on GitHub. Run that agent or ask the user instead of writing the line yourself.';
  }
  if (!READ_ONLY.has(c.cmd) && [...pathArgs(c), ...redirectTargets(c.text).map(w => w.text)].some(a => PENDING_PATH.test(a))) return SAVED_VERDICTS;
  if (c.cmd !== 'gh') return null;
  const built = builtBody(c, ghGroup, ghAction);
  if (built) return `The ${built} text comes from a substitution or variable the guard cannot see, so it cannot check it for a bstack verdict line. Write the text to a file and pass the file (--body-file, --notes-file or -F body=@<path>).`;
  for (const file of bodyFiles(c.args)) {
    const sources = file === '-' ? stdinFiles(c) : [{ file, at: c }];
    if (c.movesDir || sources?.some(source => source.at.movesDir)) return MOVED_BODY;
    if (!sources) return 'The guard cannot see what reaches the body on stdin, so it cannot check it for a bstack verdict line. Redirect a file with < <path>, pipe one with cat <path> |, or give the body file as a path.';
    for (const source of sources) {
      const reason = bodyFileReason(source, deps);
      if (reason) return reason;
    }
  }
  return null;
}

function bodyFileReason({ file, at }, deps) {
  const { word, dialect } = inTempDir(file, at.dialect, deps.host);
  const target = resolvedDir(word, at.cwdKnown ? at.cwd : UNKNOWN_DIR, dialect, deps.host.paths);
  const text = target === UNKNOWN_DIR ? null : deps.readFile(target);
  if (text === null) return `The guard cannot read the body file ${file} to check it for a bstack verdict line. Give a literal path to a file that exists.`;
  if (MARKER.test(text)) return `The body file ${file} contains a bstack verdict or user-OK line. Only the bstack hook and the user write those.`;
  return null;
}

const STDIN_FD = /^0*$/;
const OTHER_FD = /^\d+$/;
const REDIRECT_CHAR = /[<>]/;
const UNREADABLE_INPUT = /^[<&(>]/;
const STDIN_READERS = new Set(['cat', 'type', 'get-content', 'gc']);
const READER_VALUED = ['encoding', 'totalcount', 'head', 'first', 'tail', 'last', 'readcount', 'delimiter', 'stream', 'filter', 'include', 'exclude'];

function inputRedirects(text) {
  const all = words(text);
  const files = [];
  for (let i = 0; i < all.length; i++) {
    const { text: word, unquoted } = all[i];
    const at = unquoted.indexOf('<');
    if (at < 0) continue;
    const fd = unquoted.slice(0, at);
    if (REDIRECT_CHAR.test(fd + unquoted.slice(at + 1))) return null;
    if (!STDIN_FD.test(fd)) { if (OTHER_FD.test(fd)) continue; return null; }
    const target = at + 1 < word.length ? { text: word.slice(at + 1), unquoted: unquoted.slice(at + 1) } : all[++i];
    if (!target?.text || REDIRECT_CHAR.test(target.unquoted) || UNREADABLE_INPUT.test(target.text)) return null;
    files.push(target.text);
  }
  return files;
}

function stdinFiles(c) {
  const redirected = inputRedirects(c.text);
  if (redirected?.length) return redirected.map(file => ({ file, at: c }));
  const reader = c.pipedFrom;
  if (!redirected || !STDIN_READERS.has(reader?.cmd)) return null;
  const files = readerFiles(reader);
  return files?.length ? files.map(file => ({ file, at: reader })) : null;
}

function readerFiles(reader) {
  const files = inputRedirects(reader.text);
  if (!files) return null;
  const all = words(reader.text);
  const args = all.slice(all.length - reader.args.length);
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const { text: a, unquoted } = args[i];
    if (a === '-') return null;
    if (/^(\d*[<>]|&>)/.test(unquoted)) { if (/^(\d*[<>]{1,2}|&>>?)$/.test(unquoted)) i++; continue; }
    if (operands || !a.startsWith('-')) files.push(a);
    else if (a === '--') operands = true;
    else if (reader.dialect === 'powershell' && namesParameter(a, READER_VALUED, 'powershell')) i++;
  }
  return files;
}

const PENDING_PATH = new RegExp(String.raw`(^|[\\/>=])${PENDING_NAME.source}([\\/]|$)`, 'i');
const MESSAGE_OPTS = new Set(['-m', '--message', '-b', '--body', '-t', '--title']);

function pathArgs({ cmd, args }) {
  if (cmd !== 'git' && cmd !== 'gh') return args;
  return args.filter((a, i) => !MESSAGE_OPTS.has(args[i - 1]) && !/^--(message|body|title)=/.test(a));
}

const GH_SHORT_F_IS_FIELD = new Set(['api', 'workflow run']);

function parseGh(args) {
  const at = [];
  for (let i = 0; i < args.length && at.length < 2; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') i++;
    else if (a.startsWith('--repo=') || /^-R./.test(a)) continue;
    else if (a.startsWith('-')) return { at, flag: a };
    else at.push(i);
  }
  return { at, flag: null };
}

export function ghSubcommand(args) {
  return parseGh(args).at.map(i => args[i]);
}

function shortFIsField(args) {
  const [cmd, sub] = ghSubcommand(args);
  return GH_SHORT_F_IS_FIELD.has(cmd) || GH_SHORT_F_IS_FIELD.has(`${cmd} ${sub}`);
}

const GH_BOOLEAN_SHORTHANDS = 'acdefiprwy';

function flagValues(args, long, short) {
  const cluster = short && new RegExp(`^-[${GH_BOOLEAN_SHORTHANDS}]*[${short}](=?)(.*)$`, 's');
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.split('=')[0];
    const m = !a.startsWith('--') && cluster?.exec(a);
    if (a.startsWith('--') && long.includes(name)) found.push(a === name ? { at: ++i, value: args[i] } : { at: i, value: a.slice(name.length + 1) });
    else if (m) found.push(m[1] || m[2] ? { at: i, value: m[2] } : { at: ++i, value: args[i] });
  }
  return found.filter(f => f.value !== undefined);
}

function fieldFile(value) {
  const v = value.slice(value.indexOf('=') + 1);
  return value.includes('=') && v.startsWith('@') ? v.slice(1) : null;
}

function bodyFiles(args) {
  const fieldShort = shortFIsField(args) ? 'F' : null;
  const files = flagValues(args, ['--body-file', '--input', '--notes-file'], fieldShort ? null : 'F').map(f => f.value);
  const fields = flagValues(args, ['--field'], fieldShort).map(f => fieldFile(f.value));
  return [...files, ...fields].filter(Boolean);
}

const BODY_FLAGS = { body: [['--body'], 'b'], comment: [['--comment'], 'c'], notes: [['--notes'], 'n'] };
const BODY_TEXT = {
  'pr comment': 'body', 'pr create': 'body', 'pr edit': 'body', 'pr review': 'body',
  'issue comment': 'body', 'issue create': 'body', 'issue edit': 'body',
  'pr close': 'comment', 'issue close': 'comment', 'release create': 'notes', 'release edit': 'notes',
};

function builtBody(c, group, action) {
  const built = f => c.expands?.has(f.at) || c.expressions?.has(f.at);
  const kind = BODY_TEXT[`${group} ${action}`];
  if (kind && flagValues(c.args, ...BODY_FLAGS[kind]).some(built)) return BODY_FLAGS[kind][0][0];
  if (group === 'api' && flagValues(c.args, ['--field', '--raw-field'], 'fF').some(f => f.value.startsWith('body=') && built(f))) return 'body field';
  return null;
}

// --- reviewer, adversary and comment-critic judge: they run only what this allowlist names -----------
const nameSet = text => new Set(text.trim().split(/\s+/));
const isLongOptionPrefixOf = (word, full) => { const name = word.split('=')[0]; return name.length > 2 && name.startsWith('--') && full.startsWith(name); };
const clusterHas = (word, letters) => /^-[^-]/.test(word) && [...word.slice(1)].some(ch => letters.includes(ch));
const namesAny = (word, letters, longs) => clusterHas(word, letters) || longs.some(full => isLongOptionPrefixOf(word, full));
const ALLOWED_SUMMARY = 'read-only git and gh, file reads and searches, tests and the app run from its own worktree, HTTP to localhost, and file writes inside its worktree or the temp dir';
const refuse = (agent, what, fix = 'Report what you would run instead.') => `The ${agent} agent runs only allowlisted commands (${ALLOWED_SUMMARY}). Refused: ${what}. ${fix}`;

const CONTROL = nameSet('for switch fi done esac case in try catch finally return break continue exit throw [ [[ test true false');
const READS = {
  posix: nameSet(`cat head tail ls dir wc grep egrep fgrep rg find echo printf pwd basename dirname realpath readlink stat which type
    diff cmp comm cut tr nl jq sleep du df sha256sum sha1sum md5sum printenv whoami uname ps sort uniq set export`),
  powershell: nameSet(`get-content gc cat type get-childitem gci ls dir select-string sls test-path resolve-path rvpa get-item gi
    get-location gl pwd select-object select where-object where ? sort-object sort measure-object measure group-object group
    format-table ft format-list fl out-string out-null write-output write echo write-host convertfrom-json convertto-json
    compare-object diff join-path split-path get-date start-sleep sleep get-command gcm get-filehash get-process gps get-member gm findstr`),
  cmd: nameSet('dir type echo findstr where'),
};
const POSIX_READ_LIMITS = {
  find: args => args.find(a => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a)),
  rg: args => args.find(a => /^--pre(-glob)?(=|$)/.test(a)),
  sort: args => args.find(a => namesAny(a, 'o', ['--output', '--compress-program'])),
  uniq: args => args.filter(a => !a.startsWith('-')).length > 1 && 'with an output file',
  set: args => args.find(a => !/^([-+][euxvo]+|pipefail|errexit|nounset|xtrace)$/.test(a)),
  export: args => args.find(a => !safeVariable(a.split('=')[0])),
};

const SAFE_VARIABLES = nameSet('CI NODE_ENV FORCE_COLOR NO_COLOR TERM LANG LC_ALL TZ DEBUG');
const safeVariable = name => SAFE_VARIABLES.has(name.toUpperCase());
const inEnvironment = (name, host) => Object.keys(host.env ?? {}).some(key => key.toUpperCase() === name.toUpperCase());

function environmentRule(c, ctx) {
  const names = Object.keys(c.env).filter(name => !safeVariable(name));
  const exported = c.cmd === '' ? names.find(name => /[A-Z]/.test(name) || inEnvironment(name, ctx.host)) : names[0];
  return exported ? refuse(ctx.agent, `setting ${exported}, which can change what a command runs or where it writes`, `Set only ${[...SAFE_VARIABLES].join(', ')}.`) : null;
}

const FILTERS = ['filter', 'include', 'exclude', 'credential'];
const COMMON_VALUED = ['erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'outvariable', 'ov', 'errorvariable', 'ev',
  'warningvariable', 'wv', 'informationvariable', 'iv', 'pipelinevariable', 'pv', 'outbuffer', 'ob'];
const CONTENT = { data: ['value', 'encoding', 'stream', ...FILTERS], content: true, piped: ['path'] };
const POWERSHELL_WRITERS = {
  'remove-item': { data: ['stream', ...FILTERS], piped: ['path'] },
  'copy-item': { data: FILTERS, piped: ['path', 'destination'] },
  'move-item': { data: FILTERS, piped: ['path', 'destination'] },
  'rename-item': { data: ['credential'] },
  'new-item': { data: ['itemtype', 'credential'] },
  'set-content': CONTENT,
  'add-content': CONTENT,
  'clear-content': { data: ['stream', ...FILTERS], piped: ['path'] },
  'out-file': { data: ['encoding', 'inputobject', 'width'], piped: [] },
  'tee-object': { data: ['inputobject', 'variable'], piped: [] },
};
const POWERSHELL_WRITER_ALIASES = {
  rm: 'remove-item', ri: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', mv: 'move-item', move: 'move-item', mi: 'move-item',
  ren: 'rename-item', rni: 'rename-item', md: 'new-item', mkdir: 'new-item', ni: 'new-item',
  sc: 'set-content', ac: 'add-content', clc: 'clear-content', tee: 'tee-object',
};
const POWERSHELL_PATH_TAKERS = { ...POWERSHELL_WRITERS, 'set-item': CONTENT, 'clear-item': { data: FILTERS }, ...Object.fromEntries(Object.keys(DIR_MOVES).map(k => [k, { data: FILTERS }])) };
const POWERSHELL_PATH_TAKER_ALIASES = { ...POWERSHELL_WRITER_ALIASES, si: 'set-item', cli: 'clear-item' };
const WRITERS = { posix: nameSet('rm rmdir mkdir cp mv touch tee'), cmd: nameSet('del erase rd rmdir md mkdir copy move ren') };

const EXPRESSION_START = /^([$'"@(\[\d-]|\.(?![\\/.\s]))/;
const POWERSHELL_ASSIGNMENT = /^\$\{?([\w:]+)\}?\s*(?:[+\-*/%]|\?\?)?=(?!=)\s*(.*)$/s;
const POWERSHELL_OPERATOR = /^-[ci]?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|replace|split|join|contains|notcontains|in|notin|is|isnot|as|and|or|xor|not|band|bor|bxor|bnot|shl|shr|f)$/i;
const CALL_OPERATOR = /(^|[\n;|({"])\s*[&.]\s*['"$(@]/;
const PURE_TYPE = /^\[(System\.)?(IO\.Path|Math|String|Convert|Text\.RegularExpressions\.Regex|Regex|DateTime|TimeSpan|Guid|Int32|Int64|int|long|char|bool)\]$/i;
const PURE_METHODS = nameSet(`trim trimstart trimend split substring tolower toupper tolowerinvariant toupperinvariant contains startswith endswith
  indexof lastindexof padleft padright equals tostring gettype`);
const SCRIPT_BLOCK_METHODS = nameSet('where foreach');
const MEMBER_ASSIGNMENT = /^([^=]*?[\w)\]}])?\s*(\.\s*\w+|\[[^\]]*\])\s*(?:[+\-*/%]|\?\?)?=(?!=)/;
const DEFAULT_PARAMETERS = /(^|:)PSDefaultParameterValues$/i;
const withoutStrings = text => text.replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"/gs, "''");

function noAuthoringRule(line, dialect, cwd, agent, root, host) {
  const text = withoutHeredocBodies(line);
  const ctx = { agent, root, host };
  if (dialect === 'powershell' && CALL_OPERATOR.test(text)) return refuse(agent, 'the call operator & or dot-sourcing of a string, variable or expression', 'Name the command directly.');
  const parsed = commandsIn(text, 0, dialect);
  const commands = located(parsed, cwd, host).map(escapedArgsUnresolved);
  for (const [k, c] of commands.entries()) {
    const target = k > 0 && endsInRedirect(commands[k - 1].text, commands[k - 1].dialect) && words(c.text, c.dialect).length === 1;
    const reason = (target ? null : environmentRule(parsed[k], ctx) ?? agentCommandRule(c, ctx)) ?? redirectRule(c, ctx, commands[k + 1]);
    if (reason) return reason;
  }
  for (const inner of quotedSubstitutions(text, dialect)) {
    const reason = noAuthoringRule(inner, dialect, UNKNOWN_DIR, agent, root, host);
    if (reason) return reason;
  }
  return null;
}

const escapedByShell = (word, dialect) => dialect === 'posix' && word.unquoted.includes('\\');

function escapedArgsUnresolved(c) {
  const all = words(c.text, c.dialect);
  const escaped = all.slice(all.length - c.args.length).flatMap((w, i) => (escapedByShell(w, c.dialect) ? [i] : []));
  return escaped.length ? { ...c, expressions: new Set([...(c.expressions ?? []), ...escaped]) } : c;
}

function quotedSubstitutions(text, dialect) {
  const found = [];
  const ps = dialect === 'powershell';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const here = ps && !quote && /^@(['"])\r?\n/.exec(text.slice(i, i + 4));
    if (here) { quote = `\n${here[1]}@`; i += here[0].length - 1; continue; }
    if (quote === "'" || quote === "\n'@") { if (text.startsWith(quote, i)) { i += quote.length - 1; quote = null; } continue; }
    if (ch === (ps ? '`' : '\\')) { i++; continue; }
    if (quote && text.startsWith(quote, i)) { i += quote.length - 1; quote = null; continue; }
    if (!quote && (ch === '"' || ch === "'")) { quote = ch; continue; }
    if (!quote) continue;
    const close = ch === '$' && text[i + 1] === '(' ? closingParen(text, i + 1, dialect) : ch === '`' && !ps ? closingBacktick(text, i) : -1;
    if (close > 0) { found.push(text.slice(i + (ch === '$' ? 2 : 1), close)); i = close; }
  }
  return found;
}

function agentCommandRule(c, ctx) {
  const ps = c.dialect === 'powershell';
  return (ps ? dotnetRule(c.text, ctx.agent) : null) ?? (ps && EXPRESSION_START.test(c.text) ? expressionRule(c, ctx) : commandRule(c, ctx));
}

const DYNAMIC_MEMBER = /(^\s*|[\w)\]}'])\.\s*['$({]/;

function dotnetRule(text, agent) {
  const code = withoutStrings(text);
  if (DYNAMIC_MEMBER.test(code)) return refuse(agent, 'a member named by a string, variable or expression', 'Name a method from the list directly.');
  for (const m of code.matchAll(/(\[[\w.]+\])?\s*::\s*(\w*)/g)) {
    if (!PURE_TYPE.test(m[1] ?? '')) return refuse(agent, `the .NET or provider call ${m[0].trim()}`, 'Use a cmdlet from the list.');
  }
  for (const m of code.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(\s*(\{)?/g)) {
    const name = m[1].toLowerCase();
    if (!PURE_METHODS.has(name) && !(SCRIPT_BLOCK_METHODS.has(name) && m[2])) return refuse(agent, `the method call .${m[1]}()`, 'Use a cmdlet from the list; .ForEach and .Where take only a script block.');
  }
  return null;
}

function expressionRule(c, ctx) {
  const set = POWERSHELL_ASSIGNMENT.exec(c.text);
  if (set) {
    const variable = /^env:(\w+)$/i.exec(set[1]);
    if (variable && !safeVariable(variable[1])) return refuse(ctx.agent, `setting $env:${variable[1]}, which can change what a command runs or where it writes`, `Set only ${[...SAFE_VARIABLES].join(', ')}.`);
    if (DEFAULT_PARAMETERS.test(set[1])) return refuse(ctx.agent, `setting $${set[1]}, which changes where cmdlets write`);
    const value = set[2].trim();
    if (!value || EXPRESSION_START.test(value)) return value ? expressionRule({ ...c, text: value }, ctx) : null;
    return commandsIn(value, 1, 'powershell').map(inner => agentCommandRule({ ...c, ...inner, env: c.env }, ctx)).find(Boolean) ?? null;
  }
  if (MEMBER_ASSIGNMENT.test(withoutStrings(c.text))) return refuse(ctx.agent, 'assigning to a property or element of an object, which can change a file or a setting', 'Read the value instead.');
  const [first, second] = words(c.text, 'powershell');
  if (!second || first.text.endsWith(',') || /^[,+*/%=!<>.|]/.test(second.text) || POWERSHELL_OPERATOR.test(second.text) || /^-?\d/.test(second.text)) return null;
  return refuse(ctx.agent, `${first.text} ${second.text} runs a value as a command`, 'Name the command directly.');
}

function commandRule(c, ctx) {
  const { cmd, dialect, args } = c;
  if (cmd === '' || cmd in DIR_MOVES || CONTROL.has(cmd)) return null;
  if (READS[dialect]?.has(cmd)) {
    const limit = dialect === 'posix' && POSIX_READ_LIMITS[cmd]?.(args);
    return limit ? refuse(ctx.agent, `${cmd} ${limit} is not on the list`) : null;
  }
  const writer = dialect === 'powershell' ? POWERSHELL_WRITERS[POWERSHELL_WRITER_ALIASES[cmd] ?? cmd] : WRITERS[dialect]?.has(cmd) && {};
  if (writer) return writerRule(c, writer, ctx);
  const check = AGENT_COMMANDS[cmd];
  return check ? check(c, ctx) : refuse(ctx.agent, `${cmd} is not on the list`);
}

function writerRule(c, spec, ctx) {
  const ps = c.dialect === 'powershell';
  if (ps && withoutStrings(c.text).includes(',')) return refuse(ctx.agent, `${c.cmd} with a list of paths`, 'Write one literal path per command.');
  const targets = writerTargets(c, spec);
  if (typeof targets === 'string') return refuse(ctx.agent, `${c.cmd} ${targets} glues a value to an option`, 'Write the option and its value as separate words.');
  if (ps && !targets.length) return refuse(ctx.agent, `${c.cmd} without a literal path takes its targets from the pipeline`, 'Name the path.');
  const unnamed = ps && c.pipedFrom &&(spec.piped ? spec.piped.find(param => !targets.some(t => t.param === param)) : 'target');
  if (unnamed) return refuse(ctx.agent, `${c.cmd} fed from a pipeline can take its ${unnamed} from the pipeline`, 'Name every path on the command line with -Path or -LiteralPath (and -Destination), or do not pipe into it.');
  for (const { text, expression } of targets) {
    const reason = UNRESOLVABLE[c.dialect]?.test(text) ? refuse(ctx.agent, `${c.cmd} ${text}: the path cannot be resolved before it runs`, 'Use a literal path.') : insideRule(c, ctx, text, expression);
    if (reason) return reason;
  }
  return null;
}

function writerTargets(c, spec) {
  const ps = c.dialect === 'powershell';
  const namedPath = ps && c.args.some(a => namesParameter(a.split(':')[0], PATH_NAMES, 'powershell'));
  const dataNames = [...(spec.data ?? []), ...COMMON_VALUED];
  const out = [];
  let positional = namedPath ? 1 : 0;
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    const expression = c.expressions?.has(i) ?? false;
    if (a === '--' || (c.dialect === 'cmd' && /^\/[a-z?]$/i.test(a))) continue;
    if (expression || !a.startsWith('-') || a === '-') {
      const param = POSITIONAL_PARAMETERS[positional++];
      if (!(spec.content && param !== 'path')) out.push({ text: a, expression, param });
      continue;
    }
    const option = /^--?([a-z][\w-]*)(?:[=:](.*))?$/is.exec(a);
    if (!option) return a;
    const flag = `-${option[1]}`;
    const data = ps && namesParameter(flag, dataNames, 'powershell');
    const param = namesParameter(flag, PATH_NAMES, 'powershell') ? 'path' : namesParameter(flag, ['destination'], 'powershell') ? 'destination' : undefined;
    if (option[2] !== undefined) { if (!data) out.push({ text: option[2], expression, param }); continue; }
    if (!ps || namesParameter(a, POWERSHELL_SWITCHES, 'powershell')) continue;
    if (++i < c.args.length && !data) out.push({ text: c.args[i], expression: c.expressions?.has(i) ?? false, param });
  }
  return out;
}

const POSITIONAL_PARAMETERS = ['path', 'destination'];

const UNRESOLVABLE = {
  posix: /[{}]|^~[^/]/,
  powershell: /^@|::|^[a-z][\w.]+:/i,
};

function insideRule(c, ctx, word, expression) {
  const target = writeTarget(word, knownCwd(c), c.dialect, ctx.host, expression);
  if (target === null) return null;
  if (target === undefined) return refuse(ctx.agent, `${c.cmd} ${word}: the path cannot be resolved before it runs`, 'Use a literal path.');
  if (!owns(ctx.root, target, ctx.host)) return refuse(ctx.agent, `${c.cmd} on ${target}, outside its own worktree (${ctx.root}) and the temp dir`, 'Report what should change instead of changing it.');
  return null;
}

function inWorktree(c, ctx) {
  return c.cwdKnown && c.cwd !== UNKNOWN_DIR && ctx.host.paths.contains(ctx.root, c.cwd);
}

const KEY_VALUE = /^[\w.-]+=(.*)$/s;
const PATH_LIKE = /[\\/]|^\.\.?$|^~|[$`%(]/;

function argsInsideRule(c, ctx, from = 0) {
  for (let i = from; i < c.args.length; i++) {
    const a = c.args[i];
    const expression = c.expressions?.has(i) ?? false;
    if (!expression && /^\d*[<>]/.test(a)) continue;
    const option = !expression && /^--?[\w.-]*(?:=(.*))?$/s.exec(a);
    if (!option && !expression && a.startsWith('-') && a !== '-') return refuse(ctx.agent, `${c.cmd} ${a} glues a value to an option`, 'Write the option and its value as separate words.');
    const raw = option ? option[1] : a;
    const word = raw === undefined ? raw : KEY_VALUE.exec(raw)?.[1] ?? raw;
    if (word === undefined || word.includes('://') || (!expression && !PATH_LIKE.test(word))) continue;
    const reason = insideRule(c, ctx, word, expression);
    if (reason) return reason;
  }
  return null;
}

function runner(problem = () => null) {
  return (c, ctx) => {
    if (!inWorktree(c, ctx)) return refuse(ctx.agent, `${c.cmd} from ${c.cwdKnown && c.cwd ? c.cwd : 'a directory the guard cannot resolve'}; tests and the app run only from its own worktree (${ctx.root})`, `cd into ${ctx.root} first.`);
    const found = problem(c.args);
    return found ? refuse(ctx.agent, `${c.cmd} ${found}`, 'Write code to a file in your worktree and run that file, from your worktree.') : argsInsideRule(c, ctx);
  };
}

const VERSION = /^(--version|-v|-V)$/;

function nodeProblem(args) {
  if (args.length === 1 && VERSION.test(args[0])) return null;
  const inline = args.find(a => a === '-' || /^-[a-zA-Z]*[epi]/.test(a) || /^--(eval|print|interactive|input-type)(=|$)/.test(a) || a.includes('data:'));
  if (inline) return `${inline} runs code from the command line or stdin`;
  return args.includes('--test') || args.some(a => !a.startsWith('-')) ? null : 'without a script file reads code from stdin';
}

const PYTHON_MODULES = /^(pytest|unittest|uvicorn)$/;

function pythonProblem(args) {
  if (args.length === 1 && VERSION.test(args[0])) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const module = /^-m(.*)$/.exec(a);
    if (module) {
      const name = module[1] || args[i + 1];
      return PYTHON_MODULES.test(name ?? '') ? null : `-m ${name} is not a test runner on the list (pytest, unittest, uvicorn)`;
    }
    if (a === '-' || /^-[a-zA-Z]*c/.test(a)) return `${a} runs code from the command line or stdin`;
    if (/^-[WX]$/.test(a)) { i++; continue; }
    if (!a.startsWith('-')) return null;
  }
  return 'without a script file reads code from stdin';
}

const PACKAGE_COMMANDS = /^(test|t|run|run-script|start|ci|install|i)$/;

function packageProblem(args) {
  const global = args.find(a => clusterHas(a, 'g') || (isLongOptionPrefixOf(a, '--global') && !a.endsWith('=false')) || (isLongOptionPrefixOf(a, '--location') && !/=(project|user)$/.test(a)));
  if (global) return `${global} installs outside its worktree`;
  const sub = args.find(a => !a.startsWith('-'));
  return sub === undefined || PACKAGE_COMMANDS.test(sub) ? null : `${sub} is not on the list (test, run, start, install, ci)`;
}

function cargoProblem(args) {
  const sub = args.find(a => !a.startsWith('-') && !a.startsWith('+'));
  return /^(test|build|check|run|nextest)$/.test(sub ?? '') || (args.length === 1 && VERSION.test(args[0])) ? null : `${sub ?? ''} is not on the list (test, build, check, run)`;
}

function sqliteRule(c, ctx) {
  if (!c.args.some(a => /^--?safe$/.test(a))) return refuse(ctx.agent, 'sqlite3 without -safe, which can run shell commands and write other files', 'Run sqlite3 -safe <db> "select ...".');
  const db = c.args.find(a => !a.startsWith('-'));
  return db ? insideRule(c, ctx, db, false) ?? argsInsideRule(c, ctx) : refuse(ctx.agent, 'sqlite3 without a database file');
}

const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i;
const CURL_FLAGS = /^-[sSiIvfLkGg46N]+$|^--(silent|show-error|include|head|verbose|fail|fail-with-body|location|insecure|get|compressed|no-buffer|http1\.1|http2|globoff|no-progress-meter)$/;
const CURL_VALUED = /^(-[XHdmubeA]|--(request|header|data|data-raw|data-binary|data-urlencode|json|max-time|user|cookie|connect-timeout|retry|user-agent|referer))$/;
const localOnly = (ctx, url) => (LOCAL_URL.test(url) ? null : refuse(ctx.agent, `a request to ${url}; only localhost is on the list`, 'Exercise the app on localhost, never a production URL.'));

function writeOutFormat(args, i) {
  const a = args[i];
  if (a.startsWith('--write-out=')) return a.slice('--write-out='.length);
  if (/^-w./.test(a)) return a.slice(2);
  return /^(-w|--write-out)$/.test(a) ? args[i + 1] ?? '' : null;
}

function curlRule(c, ctx) {
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    const format = writeOutFormat(c.args, i);
    if (format !== null) {
      if (/%output|^@/i.test(format)) return refuse(ctx.agent, `curl ${a} with %output or a format file, which can write a file`, 'Write the format inline and print it to stdout.');
      if (/^(-w|--write-out)$/.test(a)) i++;
      continue;
    }
    const [opt, ...glued] = a.split('=');
    if (CURL_FLAGS.test(a) || /^-[XHdmubeA]./.test(a) || (glued.length && CURL_VALUED.test(opt))) continue;
    if (CURL_VALUED.test(a)) { i++; continue; }
    const output = /^(-o|--output)$/.test(opt) ? (glued.length ? glued.join('=') : c.args[++i]) : null;
    if (output !== null) { const reason = insideRule(c, ctx, output ?? '', false); if (reason) return reason; continue; }
    const url = opt === '--url' ? (glued.length ? glued.join('=') : c.args[++i] ?? '') : a.startsWith('-') ? null : a;
    if (url === null) return refuse(ctx.agent, `curl ${a} is not on the list`);
    const reason = localOnly(ctx, url);
    if (reason) return reason;
  }
  return null;
}

const WEB_VALUED = ['method', 'body', 'headers', 'contenttype', 'timeoutsec', 'maximumredirection', 'erroraction', 'useragent'];
const WEB_SWITCHES = ['usebasicparsing', 'skiphttperrorcheck', 'disablekeepalive'];

function webRule(c, ctx) {
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    let url = a;
    if (namesParameter(a, ['uri'], 'powershell')) url = c.args[++i] ?? '';
    else if (namesParameter(a, WEB_SWITCHES, 'powershell')) continue;
    else if (namesParameter(a, WEB_VALUED, 'powershell')) { i++; continue; }
    else if (a.startsWith('-')) return refuse(ctx.agent, `${c.cmd} ${a} is not on the list`);
    const reason = localOnly(ctx, url);
    if (reason) return reason;
  }
  return null;
}

const PROCESS_WORD = /^(-?\d+|%\d+|\$!|-(s|id|force|9|15|term|kill|int)|term|kill|int|\/(pid|f|t))$/i;

function killRule(c, ctx) {
  const other = c.args.find(a => !PROCESS_WORD.test(a));
  if (other || !c.args.some(a => /^(\d+|%\d+|\$!)$/.test(a))) return refuse(ctx.agent, `${c.cmd} ${other ?? ''} stops processes by something other than the id of one it started`.replace(/\s+/g, ' '), 'Stop the app by its process id.');
  return null;
}

function foreachRule(c, ctx) {
  const member = c.args.find((a, i) => !c.expressions?.has(i) && !/^(-(process|begin|end|parallel|throttlelimit)|\d+)$/i.test(a));
  return member ? refuse(ctx.agent, `${c.cmd} ${member} calls a member by name`, 'Use a script block and a method from the list.') : null;
}

const GIT_READS = nameSet(`status log show diff rev-parse merge-base ls-files ls-tree cat-file blame grep shortlog describe rev-list show-ref
  for-each-ref name-rev range-diff whatchanged count-objects check-ignore check-attr var version`);
const LS_REMOTE_FLAGS = /^(--heads|-h|--tags|-t|--branches|-b|--refs|--quiet|-q|--exit-code|--get-url|--symref|--sort=.+)$/;
const FETCH_FLAGS = /^(--all|--prune|-p|--prune-tags|-P|--tags|-t|--no-tags|-n|--quiet|-q|--verbose|-v|--dry-run|--unshallow|--no-recurse-submodules|--(depth|deepen|shallow-since|shallow-exclude|jobs|filter)(=.+)?)$/;
const CONFIG_ACTIONS = { '--get': 2, '--get-all': 2, '--get-regexp': 2, '--get-urlmatch': 2, '--list': 0, '-l': 0 };
const CONFIG_SUBCOMMANDS = { get: 1, list: 0 };
const CONFIG_READ_FLAGS = /^(--show-origin|--show-scope|--name-only|-z|--null|--global|--system|--local|--worktree|--includes|--no-includes|--bool|--int|--bool-or-int|--path|--expiry-date|--all|--regexp|--fixed-value|--(type|default|file|blob|value|url)=.*)$/;
const CONFIG_READ_VALUED = /^(--type|--default|--file|-f|--blob|--value|--url)$/;
const onlyFlags = (rest, flags) => rest.every(a => flags.test(a) || !a.startsWith('-'));

function configRead(rest) {
  const subcommand = Object.hasOwn(CONFIG_SUBCOMMANDS, rest[0] ?? '');
  const args = subcommand ? rest.slice(1) : rest;
  const actions = args.filter(a => Object.hasOwn(CONFIG_ACTIONS, a));
  if (actions.length !== (subcommand ? 0 : 1)) return false;
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    if (CONFIG_READ_VALUED.test(args[i])) i++;
    else if (!args[i].startsWith('-')) operands++;
    else if (!Object.hasOwn(CONFIG_ACTIONS, args[i]) && !CONFIG_READ_FLAGS.test(args[i])) return false;
  }
  return operands <= (subcommand ? CONFIG_SUBCOMMANDS[rest[0]] : CONFIG_ACTIONS[actions[0]]);
}
const BRANCH_LISTING = /^(--show-current|--list|-l|-[arv]+|--all|--remotes|--verbose|--contains|--no-contains|--merged|--no-merged|--points-at|--sort(=.*)?|--format(=.*)?|--color(=.*)?|--no-color|--column(=.*)?|--no-column|--abbrev(=.*)?|--no-abbrev|-i|--ignore-case|--omit-empty)$/;
const BRANCH_VALUED = /^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)$/;
const GIT_READ_FORMS = {
  '': () => true,
  branch: rest => rest.every((a, i) => BRANCH_LISTING.test(a) || BRANCH_VALUED.test(rest[i - 1] ?? '') || (rest.some(f => f === '--list' || f === '-l') && !a.startsWith('-'))),
  worktree: rest => rest[0] === 'list',
  stash: rest => /^(list|show)$/.test(rest[0] ?? ''),
  remote: rest => !rest.length || (rest.length === 1 && /^(-v|--verbose)$/.test(rest[0])) || (/^(get-url|show)$/.test(rest[0]) && onlyFlags(rest.slice(1), /^(--push|--all|-n)$/)),
  config: configRead,
  reflog: rest => !rest[0] || rest[0] === 'show' || rest[0].startsWith('-'),
  'ls-remote': rest => onlyFlags(rest, LS_REMOTE_FLAGS),
  fetch: rest => onlyFlags(rest, FETCH_FLAGS) && !rest.some(a => a.includes(':')),
};
const GIT_IN_WORKTREE = {
  checkout: rest => (rest.includes('--') || rest.includes('--detach')) && !rest.some(a => namesAny(a, 'bB', ['--orphan'])),
  switch: rest => rest.some(a => a === '--detach' || a === '-d') && !rest.some(a => namesAny(a, 'cC', ['--create', '--force-create', '--orphan'])),
  restore: () => true,
};

function gitAllowed(c, ctx) {
  const { dir, dirExpression, config, sub, rest } = parseGit(c.args, c.expressions);
  const globals = c.args.slice(0, c.args.length - rest.length - (sub ? 1 : 0));
  if (config.length || globals.some(a => /^--exec-path=/.test(a))) return refuse(ctx.agent, `git ${globals.join(' ')}: configuration on the command line can run any program`, 'Run the git command without -c.');
  const writes = rest.find(a => isLongOptionPrefixOf(a, '--output') || (sub === 'grep' && namesAny(a, 'O', ['--open-files-in-pager'])));
  if (writes) return refuse(ctx.agent, `git ${sub} ${writes}, which writes a file or runs a program`);
  if (GIT_READS.has(sub) || GIT_READ_FORMS[sub]?.(rest)) return null;
  if (GIT_IN_WORKTREE[sub]?.(rest)) {
    const here = knownCwd(c);
    const repo = !dir ? here : dirExpression ? undefined : writeTarget(dir, here, c.dialect, ctx.host, false);
    const otherTree = globals.some(a => /^--(work-tree|git-dir)\b/.test(a));
    if (otherTree || !repo || !owns(ctx.root, repo, ctx.host)) return refuse(ctx.agent, `git ${sub} on a checkout outside its own worktree (${ctx.root}), or one the guard cannot locate`, 'Read with git diff or git show instead.');
    return argsInsideRule({ ...c, cmd: `git ${sub}`, cwd: repo, cwdKnown: true }, ctx, c.args.length - rest.length);
  }
  return refuse(ctx.agent, `git ${[sub, ...rest.slice(0, 2)].join(' ')} is not on the list`, 'Read with git status, log, show or diff; restore a file in your own worktree with git restore or git checkout <commit> -- <path>.');
}

const GH_READS = new Set(['pr view', 'pr diff', 'pr checks', 'pr list', 'pr status', 'issue view', 'issue list', 'issue status', 'run view', 'run list', 'repo view']);

function ghAllowed(c, ctx) {
  const [group, action] = ghSubcommand(c.args);
  const name = `${group} ${action}`;
  if (GH_READS.has(name) || (group === 'api' && !hasWriteFields(c.args) && !c.args.some(a => /^-X(?!GET$)./i.test(a)))) return null;
  if (name === 'pr checkout' && c.args.includes('--detach') && !c.args.some(a => /^(-b|--branch|-f|--force)/.test(a))) {
    return inWorktree(c, ctx) ? null : refuse(ctx.agent, `gh pr checkout outside its own worktree (${ctx.root})`, `cd into ${ctx.root} first.`);
  }
  return refuse(ctx.agent, `gh ${[group, action].filter(Boolean).join(' ')} is not on the list`, 'Read with gh pr view, gh pr diff, gh issue view or gh api (GET); report findings in your final message, the hook posts them.');
}

const AGENT_COMMANDS = {
  git: gitAllowed, gh: ghAllowed,
  node: runner(nodeProblem), python: runner(pythonProblem), python3: runner(pythonProblem), py: runner(pythonProblem),
  pytest: runner(), uvicorn: runner(),
  npm: runner(packageProblem), pnpm: runner(packageProblem), yarn: runner(packageProblem), bun: runner(packageProblem),
  cargo: runner(cargoProblem),
  sqlite3: sqliteRule,
  curl: curlRule, 'invoke-webrequest': webRule, iwr: webRule, 'invoke-restmethod': webRule, irm: webRule,
  kill: killRule, 'stop-process': killRule, spps: killRule, taskkill: killRule,
  foreach: foreachRule, 'foreach-object': foreachRule, '%': foreachRule,
};

function agentFileRule(input, agent, root, host) {
  const file = String(input.file_path ?? input.notebook_path ?? '');
  const target = host.paths.resolvePath(root, file, 'powershell');
  return owns(root, target, host) ? null : refuse(agent, `writing ${target}, outside its own worktree (${root}) and the temp dir`, 'Report what should change instead of changing it.');
}

const PATH_NAMES = ['path', 'literalpath', 'lp', 'pspath'];
const POWERSHELL_SWITCHES = ['force', 'nonewline', 'passthru', 'append', 'noclobber', 'whatif', 'confirm', 'asbytestream', 'recurse', 'verbose', 'debug'];

function namesParameter(flag, names, dialect) {
  const name = /^-([a-z]+)$/i.exec(flag)?.[1].toLowerCase();
  if (!name) return false;
  return names.some(n => (dialect === 'powershell' ? n.startsWith(name) : n === name));
}

const NULL_SINK = /^(\$null|\/dev\/(null|stdout|stderr)|nul)$/i;

function writeTarget(word, cwd, shellDialect, host, expression) {
  if (NULL_SINK.test(word)) return null;
  const { word: inTemp, dialect } = inTempDir(word, shellDialect, host);
  const expanded = inTemp.replace(HOME, os.homedir());
  if (expression || OPAQUE.test(expanded)) return undefined;
  const asProvider = host.platform !== 'win32' && dialect === 'powershell' ? expanded.replace(/\\/g, '/') : expanded;
  if (cwd === undefined && !host.paths.isAbsolute(asProvider, dialect)) return undefined;
  return host.paths.resolvePath(cwd, asProvider, dialect);
}

function owns(root, target, host) {
  return [root, host.paths.resolvePath(host.tmpdir())].some(dir => host.paths.contains(dir, target));
}

function knownCwd(c) {
  return c.cwdKnown && c.cwd !== UNKNOWN_DIR ? c.cwd : undefined;
}

function redirectRule(c, ctx, next) {
  const clobbered = next && endsInRedirect(c.text, c.dialect) ? words(next.text, next.dialect).slice(0, 1) : [];
  for (const word of [...redirectTargets(c.text, c.dialect), ...clobbered]) {
    const reason = insideRule({ ...c, cmd: 'a redirect' }, ctx, word.text, word.expression || escapedByShell(word, c.dialect));
    if (reason) return reason;
  }
  return null;
}

// --- git ------------------------------------------------------------------------------------------
const CONCLUDES_WITH_COMMIT = /^(merge|cherry-pick|revert|rebase|am)$/;
const AM_CONTINUE = /^(--resolved|-r)$/;
const AM_WITHOUT_COMMIT = /^(--abort|--quit|--show-current-patch(=.*)?)$/;

function commitKind(sub, rest) {
  if (sub === 'commit') return 'commit';
  if (CONCLUDES_WITH_COMMIT.test(sub) && rest.includes('--continue')) return 'continue';
  if (sub !== 'am') return null;
  if (rest.some(a => AM_CONTINUE.test(a))) return 'continue';
  return rest.some(a => AM_WITHOUT_COMMIT.test(a)) ? null : 'patches';
}

function createsCommit(c) {
  if (c.cmd !== 'git') return false;
  const { sub, rest } = parseGit(c.args, c.expressions);
  return commitKind(sub, rest) !== null;
}

function gitRule(c, cwd, deps, line) {
  const { dir, dirKnown, sub, rest } = parseGit(c.args, c.expressions);
  const repo = !dirKnown ? UNKNOWN_DIR : dir ? deps.host.paths.resolvePath(cwd, dir, c.dialect) : cwd;
  if (rest.includes('--no-verify') || (sub === 'commit' && rest.some(a => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--')))) {
    return 'Do not skip git hooks (--no-verify / -n). Fix what the hook reports; it is part of the safety net.';
  }
  const commits = commitKind(sub, rest);
  if (commits) return commentRatchet({ command: c, rest: commits === 'commit' ? rest : [], unseen: commits === 'patches', ...line }, deps);
  if (sub === 'push') return pushRule(rest, i => c.expressions?.has(c.args.length - rest.length + i), repo, deps);
  if (sub === 'rebase' && !rest.some(a => /^--(abort|continue|skip|quit|edit-todo|show-current-patch)$/.test(a))) return rebaseRule(repo, deps);
  if (sub === 'pull' && rest.some(a => a === '--rebase' || a === '-r' || a.startsWith('--rebase='))) return rebaseRule(repo, deps);
  return null;
}

const UNKNOWN_BRANCH = null;
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushRule(rest, isExpression, repo, deps) {
  const flags = [];
  const positional = [];
  const unresolved = new Set();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('-')) { flags.push(a); continue; }
    const dst = a.split(':').pop();
    if (UNRESOLVED.test(dst) || /[()]/.test(dst) || (isExpression(i) && !a.includes(':'))) unresolved.add(positional.length);
    positional.push(a);
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
  const targets = refspecs.length ? refspecs.map((r, i) => {
    if (unresolved.has(i + 1)) return current();
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
    return `${branch} is already pushed, so rebasing rewrites shared history. Merge the default branch into it instead, and only when GitHub reports a conflict (a verdict carries across a merge-in that leaves the PR diff unchanged).`;
  }
  return null;
}

// --- gh -------------------------------------------------------------------------------------------
const GH_COMMANDS = new Set(['auth', 'browse', 'codespace', 'discussion', 'gist', 'issue', 'org', 'pr', 'project', 'release', 'repo', 'skill', 'cache', 'run', 'workflow', 'agent-task', 'alias', 'api', 'attestation', 'completion', 'config', 'extension', 'gpg-key', 'label', 'licenses', 'preview', 'ruleset', 'search', 'secret', 'ssh-key', 'status', 'variable', 'help', 'version']);
const GH_SINGLE_WORD = new Set(['api', 'browse', 'completion', 'help', 'licenses', 'status', 'version']);
const GH_TOP_FLAGS = new Set(['--help', '-h', '--version']);
const GH_HIDDEN_SUBCOMMAND = 'The guard cannot tell which gh command this runs (an alias, an extension, or a flag before the subcommand can hide gh pr merge), so it fails closed. Write the full command with the subcommand first: gh pr merge <n> --squash --delete-branch, gh pr view <n>, and so on.';
const GH_COPILOT = 'gh copilot starts an agent that can run gh pr merge or git push outside this hook, so the guard cannot gate what it does. Run the gh or git command yourself.';

function ghRule(c, cwd, deps, line) {
  const { at, flag } = parseGh(c.args);
  const [group, action] = at.map(i => c.args[i]);
  if (group === 'copilot') return GH_COPILOT;
  if (group === undefined ? flag !== null && !GH_TOP_FLAGS.has(flag) : !GH_COMMANDS.has(group)) return GH_HIDDEN_SUBCOMMAND;
  if (action === undefined && flag !== null && !GH_SINGLE_WORD.has(group) && !GH_TOP_FLAGS.has(flag)) return GH_HIDDEN_SUBCOMMAND;
  const without = n => c.args.filter((_, i) => !at.slice(0, n).includes(i));
  if (group === 'pr' && action === 'merge') return mergeGate(without(2), cwd, deps, c, line);
  if (group === 'api') return apiRule(without(1));
  return null;
}

function hasWriteFields(args) {
  return args.some(a => /^-[a-zA-Z]*[fF]|^--(field|raw-field|input)(=|$)/.test(a)) ||
    apiWords(args).methods.some(m => !/^GET$/i.test(m));
}

const API_LONG_VALUES = new Set(['--method', '--header', '--raw-field', '--field', '--input', '--jq', '--template', '--hostname', '--cache', '--preview']);
const API_SHORT_VALUES = new Set(['X', 'H', 'f', 'F', 'q', 't', 'p']);

function apiWords(args) {
  const methods = [];
  let endpoint = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--method=')) { methods.push(a.slice(9)); continue; }
    if (API_LONG_VALUES.has(a)) { if (a === '--method') methods.push(args[i + 1] ?? ''); i++; continue; }
    if (a.startsWith('--')) continue;
    if (!a.startsWith('-')) { endpoint ||= a; continue; }
    const at = [...a].findIndex((ch, j) => j > 0 && API_SHORT_VALUES.has(ch));
    if (at < 0) continue;
    const value = at + 1 < a.length ? a.slice(at + 1).replace(/^=/, '') : (args[++i] ?? '');
    if (a[at] === 'X') methods.push(value);
  }
  return { methods, endpoint };
}

function apiRule(args) {
  const { endpoint } = apiWords(args);
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

const MERGE_VALUE_OPTS = new Set(['--repo', '--body', '--body-file', '--subject', '--match-head-commit', '--author-email']);
const MERGE_SHORT_VALUES = new Set(['R', 'b', 'F', 't', 'A']);
const SQUASH_FLAG = /^(?:-s|--squash)(?:=|$)/;
const SQUASH_ON = /^(?:-s|--squash)(?:=(?:1|t|T|true|TRUE|True))?$/;
const GH_REPO_NAME = /GH_REPO/gi;
const SHELL_QUOTING = /[\\'"`^]/g;
const GH_REPO_OFF_COMMAND = 'This line names GH_REPO outside a prefix on gh pr merge, and the guard does not follow shell variables, so it cannot tell which repository gh merges in. Write the repository out on the merge command: gh pr merge <n> -R owner/repo --squash --delete-branch.';

function mergeArgs(args) {
  const flags = [];
  let selector = null;
  let repo = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MERGE_VALUE_OPTS.has(a)) { if (a === '--repo') repo = args[i + 1]; i++; continue; }
    if (a.startsWith('--repo=')) { repo = a.slice(7); continue; }
    if (/^-[^-]/.test(a)) {
      const end = [...a].findIndex((ch, j) => j > 0 && (ch === '=' || MERGE_SHORT_VALUES.has(ch)));
      const letters = [...a.slice(1, end < 0 ? a.length : end)].map(ch => `-${ch}`);
      if (a[end] === '=') { flags.push(...letters.slice(0, -1), `${letters.at(-1)}${a.slice(end)}`); continue; }
      flags.push(...letters);
      if (end < 0) continue;
      const value = end + 1 < a.length ? a.slice(end + 1).replace(/^=/, '') : args[++i];
      if (a[end] === 'R') repo = value;
      continue;
    }
    if (a.startsWith('-')) flags.push(a); else selector ??= a;
  }
  return { flags, selector, repo };
}

const isGhRepo = (name, host) => (host.platform === 'win32' ? name.toUpperCase() : name) === 'GH_REPO';

function prefixGhRepos(c, host) {
  const all = words(c.text).map(w => w.text);
  const prefix = all.slice(0, all.length - c.args.length - 1);
  const sets = prefix.map(w => ASSIGNMENT.exec(w));
  if (!sets.every((set, i) => set || prefix[i] === 'env')) return [];
  return sets.filter(set => set && isGhRepo(set[1], host)).map(set => set[2]);
}

function hookGhRepo(host) {
  return Object.entries(host.env ?? {}).find(([name]) => isGhRepo(name, host))?.[1] || null;
}

function mergeGate(args, cwd, deps, c, line) {
  const { flags, selector, repo: flagRepo } = mergeArgs(args);
  if (flags.includes('--auto')) return 'Auto-merge is blocked: it would merge later without the verdict check. Wait for CI and the verdict, then gh pr merge <n> --squash --delete-branch.';
  if (flags.includes('--admin')) return '--admin bypasses the repo rules. Merge normally once CI and the verdict are in.';
  if (!SQUASH_ON.test(flags.filter(f => SQUASH_FLAG.test(f)).at(-1) ?? '')) return 'Squash merge only: gh pr merge <n> --squash --delete-branch.';
  const prefixRepos = prefixGhRepos(c, deps.host);
  if (!flagRepo && (line.replace(SHELL_QUOTING, '').match(GH_REPO_NAME)?.length ?? 0) > prefixRepos.length) return GH_REPO_OFF_COMMAND;
  const repo = flagRepo || (prefixRepos.length ? prefixRepos.at(-1) || null : hookGhRepo(deps.host));
  if (repo && /[$%`()]/.test(repo)) return `The guard cannot see what ${flagRepo ? repo : `GH_REPO=${repo}`} holds, so it cannot read the verdict from that repository. Write the repository out: gh pr merge <n> -R owner/repo --squash --delete-branch.`;

  const target = [...(selector ? [selector] : []), ...(repo ? ['-R', repo] : [])];
  let pr;
  try {
    pr = JSON.parse(deps.gh(cwd, ['pr', 'view', ...target, '--json', 'number,url,headRefOid,baseRefName,state,statusCheckRollup,comments']));
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
  const prRepo = repoOfUrl(pr.url) ?? repo;
  let extraPaths;
  try { extraPaths = policyLines(readBasePolicy(args => deps.gh(cwd, args), prRepo, pr.baseRefName, RISK_PATHS)); }
  catch (e) { return `bstack could not read ${RISK_PATHS} from ${pr.baseRefName} in ${prRepo} (${String(e?.stderr || e?.message || e).trim().split('\n')[0]}). Retry the merge once gh auth status and the network are fine; the gate fails closed.`; }
  const risk = riskTier(diff, { extraPaths, readFile: ghFileReader(args => deps.gh(cwd, args), prRepo, sha) });
  if (risk.tier === 0) return null;

  const why = risk.reasons.length ? ` (${risk.reasons.slice(0, 3).join('; ')})` : '';
  const judged = carrier(pr, risk, { cwd, deps, repo: prRepo, extraPaths });
  const verdict = judged('verdict');
  if (!verdict.result) return `Tier ${risk.tier}${why}: no reviewer verdict for head ${short}.${verdict.note ?? ''} Run the bstack:reviewer agent on ${pr.url}; its hook posts the verdict.`;
  if (verdict.result.result === 'FAIL') return `The latest verdict for ${verdict.from.slice(0, 7)} is FAIL. Fix it, push, and run bstack:reviewer again.`;
  if (risk.tier === 2) {
    const rounds = blockingRounds(pr.comments);
    if (rounds >= INTERROGATE_ROUNDS) {
      if (userOkFor(pr.comments, sha)) return postCarried(pr, risk, [verdict], cwd, deps);
      return `${rounds} interrogate rounds found blocking findings: stop and report to the user what is fixed, what is open and your recommendation. The guard merges ${short} only after the user comments this line on the PR: bstack-user-ok sha=${sha}`;
    }
    const inter = judged('interrogate');
    if (!inter.result) return `Tier 2${why}: run bstack:interrogate on head ${short} before merging, and get the user's OK if a revert cannot undo it.${inter.note ?? ''}`;
    if (inter.result.blocking > 0) return `Interrogate found ${inter.result.blocking} blocking finding(s) on ${inter.from.slice(0, 7)}. Fix them through the bug-fix playbook, then review again.`;
    return postCarried(pr, risk, [verdict, inter], cwd, deps);
  }
  return postCarried(pr, risk, [verdict], cwd, deps);
}

// --- results judged on an older head, carried across merge-ins of the base branch -------------------
const LABELS = {
  verdict: r => `reviewer verdict ${r.result}`,
  interrogate: r => `interrogate result confirmed=${r.confirmed} blocking=${r.blocking}`,
};
const PLAIN_BRANCH = /^[\w.-]+(\/[\w.-]+)*$/;
const shortList = paths => paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');

function carrier(pr, risk, { cwd, deps, repo, extraPaths }) {
  const head = pr.headRefOid;
  const base = pr.baseRefName;
  const api = args => deps.gh(cwd, ['api', ...args]);
  const diffs = new Map();
  const diffAt = sha => {
    if (!diffs.has(sha)) diffs.set(sha, api(['-H', 'Accept: application/vnd.github.diff', `repos/${repo}/compare/${base}...${sha}`]));
    return diffs.get(sha);
  };
  const checks = new Map();
  let chain;

  const loadChain = () => {
    if (!PLAIN_BRANCH.test(base ?? '')) throw new Error(`the base branch name ${JSON.stringify(base)} cannot go into a GitHub API path as it is`);
    return prMergeInChain(api, repo, pr.number, head);
  };

  const check = (from, merges) => {
    const change = sameChange(diffAt(from), diffAt(head), tierZeroDocs(extraPaths));
    if (change.binary.length) return { refused: `the PR diff has binary files (${shortList(change.binary)})` };
    if (!change.same) return { refused: `the PR diff changed${change.changed.length ? ` in ${shortList(change.changed)}` : ''}` };
    const tierBefore = riskTier(diffAt(from), { extraPaths, readFile: ghFileReader(args => deps.gh(cwd, args), repo, from) }).tier;
    if (risk.tier > tierBefore) return { refused: `the risk tier rose from ${tierBefore} to ${risk.tier}` };
    if (risk.tier === 2 && change.overlap.length) return { refused: `${base} changed ${shortList(change.overlap)}, which this tier 2 PR also changes` };
    return { merges, fingerprint: change.fingerprint, tierBefore };
  };

  return kind => {
    const own = latestFor(kind, pr.comments, head);
    if (own) return { result: own, from: head };
    const judgedShas = new Set((pr.comments ?? []).map(c => shaOf(kind, c.body)).filter(s => s && s !== head));
    if (!judgedShas.size) return { result: null };
    const named = `The ${kind} on ${[...judgedShas].map(s => s.slice(0, 7)).join(', ')} does not carry to ${head.slice(0, 7)}`;
    try {
      chain ??= loadChain();
      const at = chain.findIndex(s => judgedShas.has(s));
      if (at < 0) return { result: null, note: ` ${named}: the commits after it are not only merges of ${base}.` };
      const from = chain[at];
      if (!checks.has(from)) checks.set(from, check(from, chain.slice(0, at)));
      const proof = checks.get(from);
      if (proof.refused) return { result: null, note: ` The ${kind} on ${from.slice(0, 7)} does not carry to ${head.slice(0, 7)}: ${proof.refused}.` };
      return { result: latestFor(kind, pr.comments, from), from, kind, ...proof };
    } catch (e) {
      return { result: null, note: ` ${named}: bstack could not check it (${String(e.message ?? e).split('\n')[0]}).` };
    }
  };
}

function carriedComment(pr, risk, carried) {
  const head = pr.headRefOid;
  const short = s => s.slice(0, 7);
  const lines = ['<!-- bstack-carried v1 -->', `The merge guard used results judged on an older head for head ${head}:`];
  for (const r of carried) lines.push(`- ${LABELS[r.kind](r.result)}, judged on ${r.from}`);
  for (const r of new Map(carried.map(c => [c.from, c])).values()) {
    lines.push('', `Why the result on ${short(r.from)} holds for ${short(head)}:`,
      `- Every commit after it is a merge of ${pr.baseRefName}: ${r.merges.map(short).join(', ')}.`,
      `- The PR diff is the same on both heads: ${r.fingerprint} (index lines and hunk headers left out; docs files by their added and removed lines).`,
      `- Risk tier ${r.tierBefore} on ${short(r.from)}, ${risk.tier} on ${short(head)}.`,
      ...(risk.tier === 2 ? [`- ${pr.baseRefName} changed none of the files this PR changes, other than docs.`] : []));
  }
  lines.push(`- CI is green on ${short(head)}.`);
  return `${lines.join('\n')}\n`;
}

function postCarried(pr, risk, results, cwd, deps) {
  const carried = results.filter(r => r.from !== pr.headRefOid);
  if (!carried.length) return null;
  const body = carriedComment(pr, risk, carried);
  if ((pr.comments ?? []).some(c => String(c.body ?? '').trim() === body.trim())) return null;
  try { deps.postComment(cwd, pr.url, body); }
  catch (e) { return `bstack could not post why the result on ${carried[0].from.slice(0, 7)} holds for ${pr.headRefOid.slice(0, 7)} (${String(e.message ?? e).split('\n')[0]}). Retry the merge; the gate fails closed.`; }
  return null;
}

// Verdicts the hook saved while GitHub did not answer: post the ones it accepted for this head, drop
// other heads, empty entries and entries a verdict of the same kind posted since then has replaced.
function postSaved(pr, cwd, deps) {
  const repo = repoOfUrl(pr.url);
  if (!repo) return null;
  pr.comments ??= [];
  for (const { file, entry } of deps.pending.list(repo, String(pr.number))) {
    const body = String(entry.body ?? '');
    if ((entry.head ?? entry.sha) !== pr.headRefOid || !(entry.kind in KINDS) || !body.trim() || replaced(entry, pr.comments)) { deps.pending.remove(file); continue; }
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
  const savedAt = Date.parse(entry.at ?? '') || 0;
  return comments.some(c => shaOf(entry.kind, c.body) === entry.sha && timeOf(c) > savedAt);
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
  return 'Files must not carry bstack verdict or user-OK lines: only the bstack hook and the user write those.';
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

const envWithoutGhRepo = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'GH_REPO'));
const gh = retryOnTimeout((cwd, args, timeout) => execFileSync('gh', args, { cwd, env: envWithoutGhRepo(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 << 20 }));

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
