// The verdict format shared by the SubagentStop hook (which posts verdicts) and the guard (which reads
// them before a merge). Only the hook may write the marker; the guard blocks it in agent commands.

export const MARKER = /bstack-(verdict|interrogate)/i;

export const KINDS = {
  verdict: {
    tag: '<!-- bstack-verdict v1 -->',
    // What the reviewer agent ends its report with.
    report: /^\s*`?bstack-verdict:\s*(PASS\+NOTES|PASS|FAIL)\s+pr=#?(\S+?)\s+sha=([0-9a-f]{40})`?\s*$/gim,
    // The canonical line the hook writes into the comment.
    line: /^bstack-verdict: (PASS\+NOTES|PASS|FAIL) sha=([0-9a-f]{40})$/m,
  },
  interrogate: {
    tag: '<!-- bstack-interrogate v1 -->',
    report: /^\s*`?bstack-interrogate:\s*confirmed=(\d+)\s+pr=#?(\S+?)\s+sha=([0-9a-f]{40})`?\s*$/gim,
    line: /^bstack-interrogate: confirmed=(\d+) sha=([0-9a-f]{40})$/m,
  },
};

// Parse the last result line of an agent's report. Returns { result, pr, sha, body } or null.
export function parseReport(kind, text) {
  const re = new RegExp(KINDS[kind].report.source, 'gim');
  let last = null;
  for (const m of String(text ?? '').matchAll(re)) last = m;
  if (!last) return null;
  const body = String(text).replace(last[0], '').trim();
  const result = kind === 'verdict' ? last[1].toUpperCase() : Number(last[1]);
  return { result, pr: last[2], sha: last[3].toLowerCase(), body };
}

const JUDGED_AT = /^<!-- bstack-judged-at (\S+) -->$/;

export function commentBody(kind, result, sha, report, judgedAt) {
  const line = kind === 'verdict'
    ? `bstack-verdict: ${result} sha=${sha}`
    : `bstack-interrogate: confirmed=${result} sha=${sha}`;
  const text = String(report ?? '').slice(0, 60000);
  const stamp = judgedAt ? `<!-- bstack-judged-at ${judgedAt} -->\n` : '';
  return `${KINDS[kind].tag}\n${line}\n${stamp}\n${text}\n`;
}

export const timeOf = c => Date.parse(JUDGED_AT.exec(String(c.body ?? '').split('\n')[2] ?? '')?.[1] ?? c.createdAt ?? 0) || 0;

// The newest result of a kind for exactly this head SHA, from `gh pr view --json comments`.
export function latestFor(kind, comments, sha) {
  const { tag, line } = KINDS[kind];
  const hits = (comments ?? [])
    .filter(c => String(c.body ?? '').startsWith(tag))
    .map(c => ({ at: timeOf(c), m: line.exec(String(c.body)) }))
    .filter(h => h.m && h.m[2] === sha)
    .sort((a, b) => a.at - b.at);
  if (!hits.length) return null;
  const m = hits.at(-1).m;
  return kind === 'verdict' ? { result: m[1] } : { confirmed: Number(m[1]) };
}
