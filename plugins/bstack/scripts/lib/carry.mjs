// When a result judged on an older head of a PR also holds for its current head: every commit in
// between is a merge of the base branch, and the PR's own diff is the same on both heads.
import { createHash } from 'node:crypto';
import { parseDiff } from '../risk-tier.mjs';

export const GITHUB_COMMIT_LIST_LIMIT = 250;

// A second parent that is not a PR commit is on the base branch.
export function mergeInChain(commits, head) {
  const bySha = new Map(commits.map(c => [c.sha, c]));
  const chain = [head];
  for (let c = bySha.get(head); c?.parents.length === 2 && !bySha.has(c.parents[1]) && bySha.has(c.parents[0]); c = bySha.get(c.parents[0])) {
    chain.push(c.parents[0]);
  }
  return chain;
}

// The merge-in chain from head, read from GitHub. Throws when the list cannot be read or may be cut off.
export function prMergeInChain(api, repo, number, head) {
  if (!repo) throw new Error('the repository of the PR is unknown');
  const rows = api(['--paginate', `repos/${repo}/pulls/${number}/commits?per_page=100`, '--jq', '.[] | [.sha] + [.parents[].sha] | join(" ")'])
    .split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/));
  if (rows.length >= GITHUB_COMMIT_LIST_LIMIT) throw new Error(`the PR has ${rows.length} commits, and GitHub lists at most ${GITHUB_COMMIT_LIST_LIMIT}`);
  return mergeInChain(rows.map(([sha, ...parents]) => ({ sha, parents })), head);
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/s;
const MOVES_WITH_BASE = /^(index |similarity index |dissimilarity index )/;
const BINARY = /^(Binary files |GIT binary patch)/;

function fileBlocks(diff) {
  const blocks = [];
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) blocks.push([]);
    if (line) blocks.at(-1)?.push(line);
  }
  return blocks;
}

function fileShape(lines, isDocs) {
  const [file] = parseDiff(lines.join('\n'));
  const firstHunk = lines.findIndex(l => l.startsWith('@@'));
  const header = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const hunks = firstHunk < 0 ? [] : lines.slice(firstHunk);
  const docs = isDocs(file.path);
  const compared = docs
    ? hunks.filter(l => l.startsWith('+') || l.startsWith('-'))
    : [...header.filter(l => !MOVES_WITH_BASE.test(l)), ...hunks.map(l => l.replace(HUNK_HEADER, '@@'))];
  return {
    path: file.path,
    docs,
    binary: lines.some(l => BINARY.test(l)),
    preImage: /^index ([0-9a-f]+)\.\./.exec(header.find(l => l.startsWith('index ')) ?? '')?.[1] ?? null,
    key: [file.oldPath ?? file.path, file.path, ...compared].join('\n'),
  };
}

const fingerprintOf = files => `sha256:${createHash('sha256').update(files.map(f => f.key).join('\n\0\n')).digest('hex')}`;

// Docs files (isDocs: tier 0 paths) compare by their added and removed lines, other files by every
// line except index lines and hunk headers. overlap: non-docs files whose pre-image differs, so the
// base branch changed them.
export function sameChange(judgedDiff, headDiff, isDocs) {
  const judged = fileBlocks(judgedDiff).map(lines => fileShape(lines, isDocs));
  const head = fileBlocks(headDiff).map(lines => fileShape(lines, isDocs));
  const judgedKeys = new Map(judged.map(f => [f.path, f.key]));
  const headKeys = new Map(head.map(f => [f.path, f.key]));
  const binary = [...new Set([...judged, ...head].filter(f => f.binary).map(f => f.path))];
  const changed = [...new Set([...judgedKeys.keys(), ...headKeys.keys()])].filter(p => judgedKeys.get(p) !== headKeys.get(p));
  const judgedPreImages = new Map(judged.map(f => [f.path, f.preImage]));
  const overlap = head.filter(f => !f.docs && (f.preImage === null || f.preImage !== judgedPreImages.get(f.path))).map(f => f.path);
  const fingerprints = { judged: fingerprintOf(judged), head: fingerprintOf(head) };
  const same = head.length > 0 && !binary.length && !changed.length && fingerprints.judged === fingerprints.head;
  return { same, binary, changed, overlap, fingerprint: fingerprints.head };
}
