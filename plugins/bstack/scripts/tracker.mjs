#!/usr/bin/env node
// Issue tracker helper for the planning layer. Two deterministic jobs agents get wrong by eye:
//   labels [-R owner/repo]           create the bstack labels a repo lacks; never edits or deletes one
//   next [<parent>] [-R owner/repo]  the frontier: open tickets with no open blocker and no assignee,
//                                    in the parent's sub-issue order, or the oldest ready-for-agent build
//                                    tickets when no parent is given (specs and maps are skipped)
// Output is JSON on stdout. Exit 1 with a message on stderr when gh fails.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABELS = [
  ['plan:map', '5319e7', 'Map of decisions for work too big or foggy for one session'],
  ['plan:spec', '1d76db', 'Spec: the destination of multi-PR work; its tickets are sub-issues'],
  ['plan:research', 'c5def5', 'Decision ticket: find a fact a decision waits on (agent alone)'],
  ['plan:prototype', 'c5def5', 'Decision ticket: a throwaway artifact to react to (with the user)'],
  ['plan:grill', 'c5def5', 'Decision ticket: settle it in conversation with the user'],
  ['plan:task', 'c5def5', 'Decision ticket: work that must happen before a decision can be made'],
  ['ready-for-agent', '0e8a16', 'Fully specified: an agent can build it alone'],
  ['ready-for-human', 'fbca04', 'Needs a person: judgement, access or manual testing'],
  ['needs-triage', 'ededed', 'Not yet evaluated'],
  ['needs-info', 'd876e3', 'Waiting for the reporter'],
  ['bug', 'd73a4a', 'Something is broken'],
  ['enhancement', 'a2eeef', 'New behaviour or improvement'],
  ['wontfix', 'ffffff', 'Will not be done; the closing comment says why'],
];

const repoArgs = repo => (repo ? ['-R', repo] : []);
const names = list => (list ?? []).map(x => x.name ?? x.login ?? x);

export function ensureLabels(gh, repo) {
  const existing = new Set(JSON.parse(gh(['label', 'list', '--limit', '500', '--json', 'name', ...repoArgs(repo)])).map(l => l.name.toLowerCase()));
  const created = [];
  for (const [name, color, description] of LABELS) {
    if (existing.has(name.toLowerCase())) continue;
    gh(['label', 'create', name, '--color', color, '--description', description, ...repoArgs(repo)]);
    created.push(name);
  }
  return { created, existing: LABELS.length - created.length };
}

const FIELDS = 'number,title,url,state,labels,assignees,blockedBy,subIssuesSummary';

function classify(issue) {
  if (issue.state && issue.state !== 'OPEN') return 'closed';
  if ((issue.assignees ?? []).length) return 'claimed';
  const blockers = issue.blockedBy?.nodes ?? issue.blockedBy ?? [];
  if (blockers.some(b => (b.state ?? 'OPEN') === 'OPEN')) return 'blocked';
  return 'ready';
}

const brief = i => ({ number: i.number, title: i.title, url: i.url, labels: names(i.labels) });
const isPlan = i => names(i.labels).some(l => l.startsWith('plan:')) || (i.subIssuesSummary?.total ?? 0) > 0;

export function frontier(gh, { parent, repo } = {}) {
  if (parent) {
    const p = JSON.parse(gh(['issue', 'view', String(parent), '--json', 'number,title,url,labels,subIssues,subIssuesSummary', ...repoArgs(repo)]));
    const open = (p.subIssues?.nodes ?? []).filter(s => s.state === 'OPEN');
    // A sub-issue can live in another repo, so each child is read by its URL.
    const children = open.map(s => JSON.parse(gh(['issue', 'view', s.url ?? String(s.number), '--json', FIELDS, ...(s.url ? [] : repoArgs(repo))])));
    return { parent: brief(p), progress: p.subIssuesSummary ?? null, ...sort(children) };
  }
  // The queue: build tickets only. Specs and maps (plan:* labels, or issues with sub-issues) are parents, not work.
  const listed = JSON.parse(gh(['issue', 'list', '--state', 'open', '--label', 'ready-for-agent', '--search', 'sort:created-asc', '--limit', '200', '--json', `${FIELDS},createdAt`, ...repoArgs(repo)]));
  listed.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.number - b.number);
  const skipped = listed.filter(isPlan).map(brief);
  return { parent: null, progress: null, ...sort(listed.filter(i => !isPlan(i))), skipped };
}

function sort(issues) {
  const out = { ready: [], blocked: [], claimed: [] };
  for (const i of issues) {
    const kind = classify(i);
    if (kind === 'claimed') out.claimed.push({ ...brief(i), assignees: names(i.assignees) });
    else if (kind !== 'closed') out[kind].push(brief(i));
  }
  return { next: out.ready[0] ?? null, ready: out.ready, blocked: out.blocked, claimed: out.claimed };
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  let repo = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-R' || a === '--repo') {
      repo = rest[++i];
      if (!repo || repo.startsWith('-')) throw new Error(`${a} needs owner/repo`);
    } else if (a.startsWith('--repo=')) {
      repo = a.slice(7);
      if (!repo) throw new Error('--repo needs owner/repo');
    } else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`one parent at most, got ${positional.join(' ')}`);
  if (cmd === 'labels' && positional.length) throw new Error('labels takes no issue');
  const ref = positional[0] ? String(positional[0]).replace(/^#/, '') : null;
  return { cmd, repo, parent: ref };
}

const realGh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 64 << 20 });

function main() {
  const { cmd, repo, parent } = parseArgs(process.argv.slice(2));
  let result;
  if (cmd === 'labels') result = ensureLabels(realGh, repo);
  else if (cmd === 'next') result = frontier(realGh, { parent, repo });
  else {
    process.stderr.write('usage: tracker.mjs labels [-R owner/repo] | next [<parent issue>] [-R owner/repo]\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    process.stderr.write(`tracker: ${String(e.stderr || e.message || e).trim().split('\n')[0]}\n`);
    process.exit(1);
  }
}
