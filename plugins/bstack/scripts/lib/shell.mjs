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

// Split one segment into words, removing quotes.
export function tokenize(segment) {
  const words = [];
  let cur = '';
  let quote = null;
  let started = false;
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
    if (/\s/.test(ch)) { if (started) { words.push(cur); cur = ''; started = false; } continue; }
    cur += ch;
    started = true;
  }
  if (started) words.push(cur);
  return words;
}

function programName(word) {
  return word.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

// Every simple command in a line, including commands nested in bash -c, pwsh -Command and cmd /c.
export function commandsIn(line, depth = 0) {
  const out = [];
  for (const segment of splitSegments(line)) {
    let words = tokenize(segment);
    while (words.length && (PREFIXES.has(words[0].toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words = words.slice(1);
    }
    if (!words.length) continue;
    const cmd = programName(words[0]);
    const args = words.slice(1);
    if (depth < 3 && SHELLS.has(cmd)) {
      const at = args.findIndex(a => /^(-c|-command|\/c|-encodedcommand)$/i.test(a));
      if (at >= 0) { out.push(...commandsIn(args.slice(at + 1).join(' '), depth + 1)); continue; }
    }
    if (depth < 3 && /^(invoke-expression|iex)$/.test(cmd) && args.length) {
      out.push(...commandsIn(args.join(' '), depth + 1));
      continue;
    }
    out.push({ cmd, args, text: segment });
  }
  return out;
}

// git global options come before the subcommand: git -C dir -c k=v push ...
export function parseGit(args) {
  let dir = null;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') { dir = args[i + 1] ?? null; i += 2; continue; }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 2; continue; }
    i += 1;
  }
  return { dir, sub: args[i] ?? '', rest: args.slice(i + 1) };
}
