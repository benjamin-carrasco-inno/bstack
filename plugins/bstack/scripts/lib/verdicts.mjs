// The verdict format shared by the SubagentStop hook (which posts verdicts) and the guard (which reads
// them before a merge). Only the hook may write the marker; the guard blocks it in agent commands.

export const MARKER = /bstack-(verdict|interrogate|user-ok)/i;

export const KINDS = {
  verdict: {
    tag: '<!-- bstack-verdict v1 -->',
    // What the reviewer agent ends its report with.
    report: /^\s*`?bstack-verdict:\s*(PASS\+NOTES|PASS|FAIL)\s+pr=#?(\S+?)\s+sha=([0-9a-f]{40})`?\s*$/gim,
    // The canonical line the hook writes into the comment.
    line: /^bstack-verdict: (PASS\+NOTES|PASS|FAIL) sha=(?<sha>[0-9a-f]{40})$/m,
  },
  interrogate: {
    tag: '<!-- bstack-interrogate v1 -->',
    report: /^\s*`?bstack-interrogate:\s*confirmed=(\d+)(?:\s+blocking=(?<blocking>\d+))?\s+pr=#?(?<pr>\S+?)\s+sha=(?<sha>[0-9a-f]{40})`?\s*$/gim,
    line: /^bstack-interrogate: confirmed=(\d+)(?: blocking=(?<blocking>\d+))? sha=(?<sha>[0-9a-f]{40})$/m,
  },
};

const findings = m => ({ confirmed: Number(m[1]), blocking: Number(m.groups.blocking ?? m[1]) });

// Parse the last result line of an agent's report. Returns { result, pr, sha, body } or null.
export function parseReport(kind, text) {
  const re = new RegExp(KINDS[kind].report.source, 'gim');
  let last = null;
  for (const m of String(text ?? '').matchAll(re)) last = m;
  if (!last) return null;
  const body = String(text).replace(last[0], '').trim();
  if (kind === 'verdict') return { result: last[1].toUpperCase(), pr: last[2], sha: last[3].toLowerCase(), body };
  return { result: findings(last), pr: last.groups.pr, sha: last.groups.sha.toLowerCase(), body };
}

const JUDGED_AT = /^<!-- bstack-judged-at (\S+) -->$/;

export function commentBody(kind, result, sha, report, judgedAt) {
  const line = kind === 'verdict'
    ? `bstack-verdict: ${result} sha=${sha}`
    : `bstack-interrogate: confirmed=${result.confirmed} blocking=${result.blocking} sha=${sha}`;
  const text = String(report ?? '').slice(0, 60000);
  const stamp = judgedAt ? `<!-- bstack-judged-at ${judgedAt} -->\n` : '';
  return `${KINDS[kind].tag}\n${line}\n${stamp}\n${text}\n`;
}

export const timeOf = c => Date.parse(JUDGED_AT.exec(String(c.body ?? '').split('\n')[2] ?? '')?.[1] ?? c.createdAt ?? 0) || 0;

export const shaOf = (kind, body) => (String(body ?? '').startsWith(KINDS[kind].tag) ? KINDS[kind].line.exec(String(body))?.groups.sha ?? null : null);

export const blockingRounds = comments => new Set((comments ?? [])
  .filter(c => shaOf('interrogate', c.body) && findings(KINDS.interrogate.line.exec(String(c.body))).blocking > 0)
  .map(c => shaOf('interrogate', c.body))).size;

// The user writes `bstack-user-ok sha=<head>` on GitHub; the guard refuses the line from agents,
// and a hook comment quoting an agent's report never counts.
const USER_OK = /^\s*bstack-user-ok sha=([0-9a-f]{40})\s*$/gim;
const HOOK_TAG = '<!-- bstack-';

export const userOkFor = (comments, sha) => (comments ?? []).some(c => {
  const body = String(c.body ?? '');
  return !body.includes(HOOK_TAG) && [...body.matchAll(USER_OK)].some(m => m[1].toLowerCase() === sha);
});

// The newest result of a kind for exactly this head SHA, from `gh pr view --json comments`.
export function latestFor(kind, comments, sha) {
  const hits = (comments ?? [])
    .filter(c => shaOf(kind, c.body) === sha)
    .map(c => ({ at: timeOf(c), m: KINDS[kind].line.exec(String(c.body)) }))
    .sort((a, b) => a.at - b.at);
  if (!hits.length) return null;
  const m = hits.at(-1).m;
  return kind === 'verdict' ? { result: m[1] } : findings(m);
}
