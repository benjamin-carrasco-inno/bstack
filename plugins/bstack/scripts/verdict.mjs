#!/usr/bin/env node
// SubagentStop hook for bstack:reviewer and bstack:adversary. It reads the agent's final report,
// checks that the SHA it judged is still the PR head or that only merges of the base branch followed
// it, and posts the report as a PR comment with the verdict marker. The model never posts verdicts
// itself, so the merge gate reads only this output.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport, commentBody } from './lib/verdicts.mjs';
import { pendingStore, repoOfUrl } from './lib/pending.mjs';
import { prMergeInChain } from './lib/carry.mjs';

export function kindOf(agentType) {
  if (/(^|:)reviewer$/.test(agentType)) return 'verdict';
  if (/(^|:)adversary$/.test(agentType)) return 'interrogate';
  return null;
}

const LAST_LINE = {
  verdict: 'bstack-verdict: <PASS|PASS+NOTES|FAIL> pr=<number> sha=<40-char head sha>',
  interrogate: 'bstack-interrogate: confirmed=<number> blocking=<number> pr=<number> sha=<40-char head sha>',
};

function readTranscript(file) {
  if (!file) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const blocks = entry => (Array.isArray(entry?.message?.content) ? entry.message.content : []);
const isHandback = block => block.type === 'tool_use' && block.name === 'SubagentHandback';
const lastBlockOf = entries => blocks(entries.findLast(e => e.type === 'assistant')).at(-1);
const endsWithHandback = entries => Boolean(lastBlockOf(entries) && isHandback(lastBlockOf(entries)));
const sizeOf = file => { try { return fs.statSync(file).size; } catch { return -1; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// SubagentStop can fire before the hand-back line reaches the transcript on disk (seen 170 ms after
// it on 2026-11-22). Re-read until the hand-back shows, the file has been quiet for `quiet` ms, or
// `limit` ms have passed.
export function readSettled(file, { pause = sleep, step = 100, quiet = 500, limit = 5000 } = {}) {
  let entries = readTranscript(file);
  let size = sizeOf(file);
  let still = 0;
  for (let waited = 0; file && !endsWithHandback(entries) && still < quiet && waited < limit; waited += step) {
    pause(step);
    const now = sizeOf(file);
    if (now === size) {
      still += step;
    } else {
      still = 0;
      size = now;
      entries = readTranscript(file);
    }
  }
  return entries;
}

// Everything the agent wrote or handed back, newest first. A run that ends with the SubagentHandback
// call arrives with no last_assistant_message, so the report is only in the transcript.
function reportTexts(input, entries) {
  const written = entries.filter(e => e.type === 'assistant').flatMap(blocks)
    .map(b => (b.type === 'text' ? b.text : isHandback(b) ? b.input?.message : null));
  return [input.last_assistant_message, ...written.reverse()].filter(Boolean);
}

function promptText(entries) {
  const first = entries.find(e => e.type === 'user');
  const content = first?.message?.content;
  return typeof content === 'string' ? content : blocks(first).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function promptedPr(entries) {
  return /\bPR\s*#?\d+(?:\s+in\s+[\w.-]+\/[\w.-]*\w)?/i.exec(promptText(entries))?.[0] ?? 'its PR';
}

const REPO = String.raw`[\w.-]+\/[\w.-]*\w`;
const PR_REFS = [
  { re: new RegExp(String.raw`\bPR\s*#?(\d+)\s+in\s+(${REPO})`, 'gi'), pr: 1, repo: 2 },
  { re: new RegExp(String.raw`\b(${REPO})#(\d+)\b`, 'g'), pr: 2, repo: 1 },
  { re: new RegExp(String.raw`github\.com\/(${REPO})\/pull\/(\d+)`, 'gi'), pr: 2, repo: 1 },
];

function repoFor(pr, texts) {
  for (const text of texts) {
    for (const ref of PR_REFS) {
      for (const m of String(text).matchAll(ref.re)) if (m[ref.pr] === pr) return m[ref.repo];
    }
  }
  return null;
}

const repoArgs = repo => (repo ? ['-R', repo] : []);

// Returns { post: { pr, repo, body } }, { block: reason } for the agent, { warn: message } for the user, or {}.
export function handle(input, gh, read = readTranscript) {
  const kind = kindOf(String(input.agent_type ?? ''));
  if (!kind) return {};
  const entries = read(input.agent_transcript_path);
  // After a hand-back the run is over: a block reaches the agent only if someone resumes it.
  const heard = !input.stop_hook_active && !endsWithHandback(entries);
  const fail = (where, problem, ask) => (heard
    ? { block: `${problem} ${ask}` }
    : { warn: `bstack: nothing was posted for ${where}. ${problem} Run a fresh ${input.agent_type} agent for it.` });

  const texts = reportTexts(input, entries);
  const report = texts.map(text => parseReport(kind, text)).find(Boolean);
  if (!report) {
    return fail(promptedPr(entries), `The ${input.agent_type} report has no result line.`,
      `End your report with exactly one line:\n${LAST_LINE[kind]}\nThe bstack hook posts it; do not post it yourself.`);
  }
  const repo = repoFor(report.pr, [...texts, promptText(entries)]);
  let pr;
  try {
    pr = JSON.parse(gh(input.cwd, ['pr', 'view', report.pr, ...repoArgs(repo), '--json', 'number,url,headRefOid,baseRefName,comments']));
  } catch (e) {
    if (transient(e)) return { save: { kind, repo, pr: report.pr, sha: report.sha, result: report.result, report: report.body } };
    const named = repo ? `PR ${report.pr} in ${repo}` : `PR ${report.pr}`;
    return fail(named, `bstack could not read ${named} (${String(e.message ?? e).split('\n')[0]}).`,
      'Check the PR number and end with the line again.');
  }
  let text = report.body;
  if (pr.headRefOid !== report.sha) {
    const moved = `PR ${pr.number} head is now ${pr.headRefOid}, not ${report.sha}`;
    const recheck = 'Check out the new head, re-check what changed, and end with the line for the new SHA.';
    let chain;
    try {
      chain = prMergeInChain(args => gh(input.cwd, ['api', ...args]), repo ?? repoOfUrl(pr.url), pr.number, pr.headRefOid);
    } catch (e) {
      return fail(pr.url, `${moved}, and bstack could not read its commits (${String(e.message ?? e).split('\n')[0]}) to check that only merges of the base branch followed.`, recheck);
    }
    if (!chain.includes(report.sha)) return fail(pr.url, `${moved}.`, recheck);
    text = `Judged on ${report.sha}. The PR head has since moved to ${pr.headRefOid} by a merge-in of ${pr.baseRefName ?? 'the base branch'}.\n\n${report.body}`;
  }
  const body = commentBody(kind, report.result, report.sha, text);
  if ((pr.comments ?? []).some(c => String(c.body ?? '').trim() === body.trim())) return {};
  return { post: { pr: pr.url, repo, body, kind, number: String(pr.number), sha: report.sha, head: pr.headRefOid, result: report.result, report: text } };
}

export const commentArgs = (post, file) => ['pr', 'comment', post.pr, ...repoArgs(post.repo), '--body-file', file];

const TRANSIENT = /ETIMEDOUT|timed? ?out|timeout|dial tcp|connectex|connection (reset|refused)|forcibly closed|broken pipe|wsarecv|wsasend|network|no such host|\bEOF\b|TLS handshake|HTTP 50[0234]|error connecting to|check your internet connection|githubstatus\.com/i;
const errorOutput = e => String(e?.message ?? e).replace(/^Command failed:[^\n]*\n?/, '').replace(/[\w.-]+\/[\w.-]+/g, '');
export const transient = e => e?.code === 'ETIMEDOUT' || TRANSIENT.test(errorOutput(e));

// Three tries over about 60 s: a 25 s gh timeout, then waits of 5 s and 15 s. hooks.json allows 210 s
// for the hook, enough for the PR read and the post to each use all three.
export function retrying(gh, { pause = sleep, delays = [5000, 15000] } = {}) {
  return (cwd, args) => {
    for (let i = 0; ; i++) {
      try {
        return gh(cwd, args);
      } catch (e) {
        if (i >= delays.length || !transient(e)) throw e;
        pause(delays[i]);
      }
    }
  };
}

function originRepo(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd || process.cwd(), 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/i.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

function postComment(cwd, post, gh) {
  const file = path.join(os.tmpdir(), `bstack-verdict-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(file, post.body, 'utf8');
  try {
    gh(cwd, commentArgs(post, file));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Returns the hook's stdout object, or null when there is nothing to say.
export function deliver(input, { gh, read = readSettled, save = pendingStore().save, origin = originRepo, now = () => new Date().toISOString() }) {
  const out = handle(input, gh, read);
  if (out.block) return { decision: 'block', reason: out.block };
  if (out.warn) return { systemMessage: out.warn };
  let unposted = out.save;
  if (out.post) {
    try {
      postComment(input.cwd, out.post, gh);
      return { systemMessage: `bstack: verdict posted on ${out.post.pr}` };
    } catch {
      const { kind, repo, number, sha, head, result, report } = out.post;
      unposted = { kind, repo: repo ?? repoOfUrl(out.post.pr), pr: number, sha, head, result, report };
    }
  }
  if (!unposted) return null;
  const { result, report, ...where } = unposted;
  const at = now();
  const saved = { ...where, repo: where.repo ?? origin(input.cwd), at, body: commentBody(where.kind, result, where.sha, report, at) };
  if (!saved.repo) {
    return { systemMessage: `bstack: GitHub did not answer and the repository of PR ${saved.pr} is unknown, so nothing was posted. Run a fresh ${input.agent_type} agent for it.` };
  }
  save(saved);
  return { systemMessage: `bstack: GitHub did not answer, so the ${saved.kind} for PR ${saved.pr} in ${saved.repo} (${saved.sha.slice(0, 7)}) was saved locally. The guard posts it at the next gh pr merge of that PR.` };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const gh = retrying((cwd, args) => execFileSync('gh', args, { cwd: cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000, maxBuffer: 64 << 20 }));
  const out = deliver(input, { gh });
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`bstack verdict hook failed: ${e.message ?? e}\n`); process.exit(1); });
}
