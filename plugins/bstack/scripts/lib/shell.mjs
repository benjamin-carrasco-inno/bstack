// Splits a shell command line (bash, sh or PowerShell) into simple commands, well enough to
// recognise git and gh invocations. It evaluates nothing: variables and substitutions stay text.

const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']);
const PREFIXES = new Set(['&', 'env', 'command', 'exec', 'time', 'nohup', 'sudo', 'call',
  'if', 'then', 'elif', 'else', 'elseif', 'while', 'until', 'do', '!']);
const flagSet = (valued = '', bare = '', chdir = '') => ({ valued: new Set(valued.split(' ')), bare: new Set(bare.split(' ')), chdir: new Set(chdir.split(' ')) });
const WRAPPER_FLAGS = {
  env: flagSet('-C --chdir -u --unset', '- -i --ignore-environment -0 --null -v --debug', '-C --chdir'),
  sudo: flagSet('-u --user -g --group -p --prompt -C --close-from -D --chdir -R --chroot -r --role -t --type -T --command-timeout -U --other-user',
    '-A --askpass -B --bell -b --background -E --preserve-env -H --set-home -i --login -K --remove-timestamp -k --reset-timestamp -N --no-update -n --non-interactive -P --preserve-groups -S --stdin -s --shell', '-D --chdir'),
  time: flagSet('-f --format -o --output', '-p --portability -a --append -v --verbose -q --quiet'),
  exec: flagSet('-a', '-c -l'),
  command: flagSet('', '-p -v -V'),
  nohup: flagSet(),
};
const LEADING_REDIRECT = /^(\d*[<>]|&>)/;
const BARE_REDIRECT = /^(\d*(<<?<?|>>?|>&|<&|>\|)|&>>?)$/;

function wrapperFlags(wrapper, parsed) {
  const spec = WRAPPER_FLAGS[wrapper];
  const chdir = [];
  let i = 0;
  while (spec && i < parsed.length && parsed[i].text.startsWith('-')) {
    const w = parsed[i].text;
    if (w === '--') { i++; break; }
    if (w.startsWith('--')) {
      const name = w.split('=')[0];
      const glued = w.includes('=');
      if (!spec.valued.has(name) && !spec.bare.has(name)) return { hidden: w };
      if (spec.chdir.has(name)) chdir.push(glued ? { text: w.slice(name.length + 1), expression: parsed[i].expression } : parsed[i + 1]);
      i += spec.valued.has(name) && !glued ? 2 : 1;
      continue;
    }
    if (w === '-') {
      if (!spec.bare.has(w)) return { hidden: w };
      i++;
      continue;
    }
    let step = 1;
    for (let k = 1; k < w.length; k++) {
      const flag = `-${w[k]}`;
      if (spec.valued.has(flag)) {
        const value = k + 1 < w.length ? { text: w.slice(k + 1), expression: parsed[i].expression } : parsed[i + 1];
        if (spec.chdir.has(flag)) chdir.push(value);
        step = k + 1 < w.length ? 1 : 2;
        break;
      }
      if (!spec.bare.has(flag)) return { hidden: w };
    }
    i += step;
  }
  return { rest: parsed.slice(i), chdir: chdir.filter(Boolean) };
}

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

function isArgument(textBefore) {
  const first = words(textBefore)[0]?.text;
  return first !== undefined && !PREFIXES.has(first.toLowerCase());
}

const DOUBLE_QUOTE_ESCAPE = { posix: '\\', powershell: '`' };
const escapesInDoubleQuotes = (ch, dialect) => ch === DOUBLE_QUOTE_ESCAPE[dialect];

function quotedSubstitution(line, i, dialect, closes) {
  if (line.startsWith('$(', i)) {
    const close = closingParen(line, i + 1, dialect, closes);
    return close > 0 ? { inner: i + 2, close } : null;
  }
  if (line[i] !== '`' || dialect !== 'posix') return null;
  const close = closingBacktick(line, i);
  return close > 0 ? { inner: i + 1, close } : null;
}

function closingParen(line, open, dialect, closes) {
  if (!closes.has(open)) closes.set(open, scanToClosingParen(line, open, dialect, closes));
  return closes.get(open);
}

function scanToClosingParen(line, open, dialect, closes) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      const sub = quote === '"' ? quotedSubstitution(line, i, dialect, closes) : null;
      if (sub) i = sub.close;
      else if (ch === quote) quote = null;
      else if (quote === '"' && escapesInDoubleQuotes(ch, dialect)) i++;
      continue;
    }
    const here = hereString(line, i);
    if (here) { i = here.end - 1; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '`' && (line[i + 1] === '`' || BRACKETS.has(line[i + 1]))) i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function closingBacktick(line, open) {
  for (let i = open + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '`') return i;
  }
  return -1;
}

// Cut a line into segments at ; && || | & newlines and ( ) { } groups, outside quotes; a substitution's commands come first.
export function splitSegments(line, dialect = 'posix') {
  const segments = [];
  let cur = '';
  let quote = null;
  const groups = [];
  const closes = new Map();
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      const sub = quote === '"' ? quotedSubstitution(line, i, dialect, closes) : null;
      if (sub) {
        segments.push(...splitSegments(line.slice(sub.inner, sub.close), dialect));
        cur += line.slice(i, sub.close + 1);
        i = sub.close;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = null;
      else if (quote === '"' && escapesInDoubleQuotes(ch, dialect) && i + 1 < line.length) cur += line[++i];
      continue;
    }
    const here = hereString(line, i);
    if (here) { cur += line.slice(i, here.end); i = here.end - 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '`' && (line[i + 1] === '`' || BRACKETS.has(line[i + 1]))) { cur += ch + line[++i]; continue; }
    const close = ch === '(' && (!opensGroup(cur) || isArgument(cur)) ? closingParen(line, i, dialect, closes)
      : ch === '`' && dialect === 'posix' ? closingBacktick(line, i) : -1;
    if (close > 0) {
      segments.push(...splitSegments(line.slice(i + 1, close), dialect));
      cur += line.slice(i, close + 1);
      i = close;
      continue;
    }
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

const EXPANDS_AFTER_DOLLAR = /^[\w{(?!#*@$-]/;
const EXPANDS_AFTER_BARE_DOLLAR = { posix: /^[\w{(?!#*@$'-]/, powershell: EXPANDS_AFTER_DOLLAR };

function expandsAt(segment, i, dialect, quoted) {
  const escaped = segment[i - 1] === ESCAPE[dialect];
  if (segment[i] === '`') return dialect === 'posix' && !escaped;
  const after = quoted ? EXPANDS_AFTER_DOLLAR : EXPANDS_AFTER_BARE_DOLLAR[dialect] ?? EXPANDS_AFTER_DOLLAR;
  return segment[i] === '$' && !escaped && after.test(segment[i + 1] ?? '');
}

// Split one segment into words, removing quotes. Only an unquoted ( is an expression; PowerShell reads a(b) as two arguments.
export function words(segment, dialect = 'posix') {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  let expression = false;
  let expands = false;
  let depth = 0;
  const end = () => { out.push({ text: cur, expression, expands }); cur = ''; started = false; expression = false; expands = false; depth = 0; };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && /["\\$`]/.test(segment[i + 1] ?? '')) { cur += segment[++i]; continue; }
      if (quote === '"' && expandsAt(segment, i, dialect, true)) expands = true;
      cur += ch;
      continue;
    }
    const here = hereString(segment, i);
    if (here) { expands ||= segment[i + 1] === '"' && /\$[\w{(]/.test(here.body); cur += here.body; started = true; i = here.end - 1; continue; }
    if (expandsAt(segment, i, dialect, false)) expands = true;
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch) && depth === 0) { if (started) end(); continue; }
    if (ch === '(') { expression = true; depth++; }
    if (ch === ')' && depth > 0) depth--;
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
    const [word] = words(segment.slice(i + 1));
    if (word?.text) targets.push(word);
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

function heredocWords(text, state) {
  const words = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.quote) {
      if (ch === state.quote) state.quote = null;
      else if (ch === '\\' && state.quote === '"') i++;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { state.quote = ch; continue; }
    if (state.parens) {
      if (ch === '(') state.parens++;
      else if (ch === ')') state.parens--;
      continue;
    }
    if (ch === '(' && text[i + 1] === '(') { state.parens = 2; i++; continue; }
    if (ch !== '<' || text[i + 1] !== '<') continue;
    if (text[i + 2] === '<') { i += 2; continue; }
    HEREDOC_OPEN.lastIndex = i;
    const m = HEREDOC_OPEN.exec(text);
    if (m) { words.push(m[2]); i = HEREDOC_OPEN.lastIndex - 1; }
  }
  return words;
}

function terminatorLine(lines, word, after) {
  return lines.findIndex((text, k) => k > after && text.replace(/\r$/, '').trim() === word);
}

export function withoutHeredocBodies(line) {
  const lines = line.split('\n');
  const out = [...lines];
  const state = { quote: null, parens: 0 };
  for (let n = 0; n < lines.length; n++) {
    let end = n;
    for (const word of heredocWords(lines[n], state)) {
      end = terminatorLine(lines, word, end);
      if (end < 0) break;
    }
    if (end <= n) continue;
    const executed = tokenize(lines[n]).some(w => SHELLS.has(programName(w)));
    if (!executed) out.fill('', n + 1, end + 1);
    n = end;
  }
  return out.join('\n');
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
  for (const segment of splitSegments(line, dialect)) {
    let parsed = words(segment, dialect);
    const env = {};
    const chdir = [];
    let redirected = false;
    let hidden = null;
    while (parsed.length && !hidden) {
      const first = parsed[0].text;
      const set = ASSIGNMENT.exec(first);
      if (set) { env[set[1]] = set[2]; parsed = parsed.slice(1); continue; }
      if (LEADING_REDIRECT.test(first)) { redirected = true; parsed = parsed.slice(BARE_REDIRECT.test(first) ? 2 : 1); continue; }
      const wrapper = programName(first);
      if (!PREFIXES.has(wrapper)) break;
      const flags = wrapperFlags(wrapper, parsed.slice(1));
      if (flags.hidden) { hidden = flags.hidden; break; }
      chdir.push(...flags.chdir);
      parsed = flags.rest;
    }
    if (!parsed.length) {
      if (Object.keys(env).length || redirected) out.push({ cmd: '', args: [], expressions: new Set(), expands: new Set(), text: segment, dialect, env, scope });
      continue;
    }
    const cmd = programName(parsed[0].text);
    const args = parsed.slice(1).map(w => w.text);
    const expressions = new Set(parsed.slice(1).flatMap((w, i) => (w.expression ? [i] : [])));
    const expands = new Set(parsed.slice(1).flatMap((w, i) => (w.expands ? [i] : [])));
    if (hidden) { out.push({ cmd, args, expressions, expands, text: segment, dialect, env, scope, hidden }); continue; }
    if (depth < 3 && SHELLS.has(cmd)) {
      const at = args.findIndex(a => /^(-c|-command|\/c|-encodedcommand)$/i.test(a));
      if (at >= 0) { out.push(...commandsIn(args.slice(at + 1).join(' '), depth + 1, DIALECT_OF_SHELL[cmd] ?? 'posix', `${scope}/${++shellCount.n}`, shellCount)); continue; }
    }
    if (depth < 3 && /^(invoke-expression|iex)$/.test(cmd) && args.length) {
      out.push(...commandsIn(args.join(' '), depth + 1, dialect, scope, shellCount));
      continue;
    }
    out.push({ cmd, args, expressions, expands, text: segment, dialect, env, scope, chdir });
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
  const config = [];
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
    if (a === '-c' || a === '--config-env') { aliases ||= ALIAS_KEY.test(value ?? ''); config.push(configKey(value)); i += 2; continue; }
    if (a.startsWith('--config-env=')) { aliases ||= ALIAS_KEY.test(a.slice(13)); config.push(configKey(a.slice(13))); }
    if (a === '--namespace') { i += 2; continue; }
    i += 1;
  }
  return { ...found, dirKnown: found.dir === null || (!dirExpression && !UNRESOLVED.test(found.dir)), dirExpression, aliases, config, sub: args[i] ?? '', rest: args.slice(i + 1) };
}

function configKey(setting = '') {
  return setting.split('=')[0].toLowerCase();
}

const DO_DONE = /(?<![\w$.-])(do|done)(?![\w-])/g;
const BRACED_LOOP = /(?<![\w$.-])(foreach-object|foreach|for|while|until|do|%)(?![\w-])/gi;

export function loopBodies(text) {
  const bodies = [];
  const open = [];
  for (const m of text.matchAll(DO_DONE)) {
    if (m[1] === 'do') open.push(m.index + 2);
    else if (open.length) bodies.push(text.slice(open.pop(), m.index));
  }
  for (const m of text.matchAll(BRACED_LOOP)) {
    const start = text.indexOf('{', m.index);
    if (start >= 0) bodies.push(text.slice(start + 1, closingBrace(text, start)));
  }
  return bodies;
}

function closingBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}
