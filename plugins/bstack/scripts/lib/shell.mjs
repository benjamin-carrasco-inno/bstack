// Splits a shell command line (bash, sh or PowerShell) into simple commands, well enough to
// recognise git and gh invocations. It evaluates nothing: variables and substitutions stay text.

const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']);
const PREFIXES = new Set(['&', 'env', 'command', 'exec', 'time', 'nohup', 'sudo', 'call',
  'if', 'then', 'elif', 'else', 'elseif', 'while', 'until', 'do', '!']);

const HERE_STRING_OPEN = /^@(['"])\r?\n/;

function hereString(text, i) {
  if (text[i] !== '@') return null;
  const open = HERE_STRING_OPEN.exec(text.slice(i, i + 4));
  if (!open) return null;
  const bodyStart = i + open[0].length;
  const close = text.indexOf(`\n${open[1]}@`, bodyStart - 1);
  if (close < 0) return null;
  return { body: text.slice(bodyStart, close).replace(/\r$/, ''), end: close + 3 };
}

const CLOSER = { '(': ')', '{': '}' };
const BRACKETS = new Set(['(', ')', '{', '}']);
const GLUED_TO_WORD = /[\w$@]$/;
const POWERSHELL_OPERATOR = /(^|\s)-[a-z]+$/i;

function opensGroup(textBefore) {
  return !GLUED_TO_WORD.test(textBefore) || POWERSHELL_OPERATOR.test(textBefore);
}

// Cut a line into segments at ; && || | & newlines and ( ) { } groups, outside quotes.
export function splitSegments(line) {
  const segments = [];
  let cur = '';
  let quote = null;
  const groups = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      continue;
    }
    const here = hereString(line, i);
    if (here) { cur += line.slice(i, here.end); i = here.end - 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '`' && (line[i + 1] === '`' || BRACKETS.has(line[i + 1]))) { cur += ch + line[++i]; continue; }
    if (ch in CLOSER) {
      const splits = opensGroup(cur);
      groups.push({ closer: CLOSER[ch], splits });
      if (splits) { segments.push(cur); cur = ''; } else cur += ch;
      continue;
    }
    if (ch === groups.at(-1)?.closer) {
      if (groups.pop().splits) { segments.push(cur); cur = ''; } else cur += ch;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') { segments.push(cur); cur = ''; continue; }
    if (ch === '|') { if (line[i + 1] === '|') i++; segments.push(cur); cur = ''; continue; }
    if (ch === '&') {
      const prev = line[i - 1];
      if (prev === '>' || line[i + 1] === '>') { cur += ch; continue; } // 2>&1, &>
      if (line[i + 1] === '&') { i++; segments.push(cur); cur = ''; continue; }
      if (cur.trim() === '') { cur += ' '; continue; } // PowerShell call operator
      segments.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments.map(s => s.trim()).filter(Boolean);
}

// Split one segment into words, removing quotes. Only an unquoted ( is an expression; PowerShell reads a(b) as two arguments.
export function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  let expression = false;
  const end = () => { out.push({ text: cur, expression }); cur = ''; started = false; expression = false; };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && /["\\$`]/.test(segment[i + 1] ?? '')) { cur += segment[++i]; continue; }
      cur += ch;
      continue;
    }
    const here = hereString(segment, i);
    if (here) { cur += here.body; started = true; i = here.end - 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) end(); continue; }
    if (ch === '(') expression = true;
    cur += ch;
    started = true;
  }
  if (started) end();
  return out;
}

export function tokenize(segment) {
  return words(segment).map(w => w.text);
}

export function redirectTargets(segment) {
  const targets = [];
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    const here = hereString(segment, i);
    if (here) { i = here.end - 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '>') continue;
    if (segment[i + 1] === '>') i++;
    if (segment[i + 1] === '&') { i++; continue; }
    if (segment[i + 1] === '|') i++;
    const [word] = tokenize(segment.slice(i + 1));
    if (word) targets.push(word);
  }
  return targets;
}

const ESCAPE = { posix: '\\', powershell: '`', cmd: '^' };
const TRAILING_REDIRECT = /(.?)\d*>>?$/s;

export function endsInRedirect(segment, dialect = 'posix') {
  const m = TRAILING_REDIRECT.exec(segment.trimEnd());
  return Boolean(m) && m[1] !== ESCAPE[dialect];
}

const HEREDOC_OPEN = /<<[-~]?[ \t]*(['"]?)([\w.-]+)\1/y;

function heredocWords(text) {
  const words = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '<' || text[i + 1] !== '<') continue;
    if (text[i + 2] === '<') { i += 2; continue; }
    HEREDOC_OPEN.lastIndex = i;
    const m = HEREDOC_OPEN.exec(text);
    if (m) { words.push(m[2]); i = HEREDOC_OPEN.lastIndex - 1; }
  }
  return words;
}

export function withoutHeredocBodies(line) {
  const pending = [];
  return line.split('\n').map(text => {
    if (pending.length) {
      const { word, executed } = pending[0];
      if (text.replace(/\r$/, '').trim() === word) pending.shift();
      return executed ? text : '';
    }
    const executed = tokenize(text).some(w => SHELLS.has(programName(w)));
    pending.push(...heredocWords(text).map(word => ({ word, executed })));
    return text;
  }).join('\n');
}

function programName(word) {
  return word.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

const DIALECT_OF_SHELL = { pwsh: 'powershell', powershell: 'powershell', cmd: 'cmd' };
export const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
export const UNRESOLVED = /[$%`]/;

// Every simple command in a line, including commands nested in bash -c, pwsh -Command and cmd /c.
export function commandsIn(line, depth = 0, dialect = 'posix', scope = '', shellCount = { n: 0 }) {
  const out = [];
  for (const segment of splitSegments(line)) {
    let parsed = words(segment);
    const env = {};
    while (parsed.length && (PREFIXES.has(parsed[0].text.toLowerCase()) || ASSIGNMENT.test(parsed[0].text))) {
      const set = ASSIGNMENT.exec(parsed[0].text);
      if (set) env[set[1]] = set[2];
      parsed = parsed.slice(1);
    }
    if (!parsed.length) {
      if (Object.keys(env).length) out.push({ cmd: '', args: [], expressions: new Set(), text: segment, env, scope });
      continue;
    }
    const cmd = programName(parsed[0].text);
    const args = parsed.slice(1).map(w => w.text);
    const expressions = new Set(parsed.slice(1).flatMap((w, i) => (w.expression ? [i] : [])));
    if (depth < 3 && SHELLS.has(cmd)) {
      const at = args.findIndex(a => /^(-c|-command|\/c|-encodedcommand)$/i.test(a));
      if (at >= 0) { out.push(...commandsIn(args.slice(at + 1).join(' '), depth + 1, DIALECT_OF_SHELL[cmd] ?? 'posix', `${scope}/${++shellCount.n}`, shellCount)); continue; }
    }
    if (depth < 3 && /^(invoke-expression|iex)$/.test(cmd) && args.length) {
      out.push(...commandsIn(args.join(' '), depth + 1, dialect, scope, shellCount));
      continue;
    }
    out.push({ cmd, args, expressions, text: segment, dialect, env, scope });
  }
  return out;
}

const ABSOLUTE = /^([a-z]:)?[\\/]/i;
const ALIAS_KEY = /^alias\./i;
const GIT_PATH_OPTS = { '--git-dir': 'gitDir', '--work-tree': 'workTree' };
const NO_EXPRESSIONS = new Set();

// git global options come before the subcommand: git -C dir --git-dir=x -c k=v push ... Each -C is relative to the one before; an empty one is ignored.
export function parseGit(args, expressions = NO_EXPRESSIONS) {
  const found = { dir: null, gitDir: null, workTree: null };
  let aliases = false;
  let dirExpression = false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    const value = args[i + 1];
    if (a === '-C') {
      if (value) {
        const absolute = found.dir === null || ABSOLUTE.test(value);
        dirExpression = expressions.has(i + 1) || (!absolute && dirExpression);
        found.dir = absolute ? value : `${found.dir}/${value}`;
      }
      i += 2;
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = GIT_PATH_OPTS[eq > 0 ? a.slice(0, eq) : a];
    if (key && eq > 0) { found[key] = a.slice(eq + 1); i += 1; continue; }
    if (key) { found[key] = value ?? null; i += 2; continue; }
    if (a === '-c' || a === '--config-env') { aliases ||= ALIAS_KEY.test(value ?? ''); i += 2; continue; }
    if (a.startsWith('--config-env=')) aliases ||= ALIAS_KEY.test(a.slice(13));
    if (a === '--namespace') { i += 2; continue; }
    i += 1;
  }
  return { ...found, dirKnown: found.dir === null || (!dirExpression && !UNRESOLVED.test(found.dir)), dirExpression, aliases, sub: args[i] ?? '', rest: args.slice(i + 1) };
}
