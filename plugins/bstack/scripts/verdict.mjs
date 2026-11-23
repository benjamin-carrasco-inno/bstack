#!/usr/bin/env node
// SubagentStop hook for bstack:reviewer and bstack:adversary. It reads the agent's final report,
// checks that the SHA it judged is still the PR head, and posts the report as a PR comment with the
// verdict marker. The model never posts verdicts itself, so the merge gate reads only this output.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReport, commentBody } from './lib/verdicts.mjs';

export function kindOf(agentType) {
  if (/(^|:)reviewer$/.test(agentType)) return 'verdict';
  if (/(^|:)adversary$/.test(agentType)) return 'interrogate';
  return null;
}

const LAST_LINE = {
  verdict: 'bstack-verdict: <PASS|PASS+NOTES|FAIL> pr=<number> sha=<40-char head sha>',
  interrogate: 'bstack-interrogate: confirmed=<number> pr=<number> sha=<40-char head sha>',
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

function promptedPr(entries) {
  const first = entries.find(e => e.type === 'user');
  const content = first?.message?.content;
  const text = typeof content === 'string' ? content : blocks(first).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return /\bPR\s*#?\d+(?:\s+in\s+[\w.-]+\/[\w.-]*\w)?/i.exec(text)?.[0] ?? 'its PR';
}

// Returns { post: { pr, body } }, { block: reason } for the agent, { warn: message } for the user, or {}.
export function handle(input, gh, read = readTranscript) {
  const kind = kindOf(String(input.agent_type ?? ''));
  if (!kind) return {};
  const entries = read(input.agent_transcript_path);
  // After a hand-back the run is over: a block reaches the agent only if someone resumes it.
  const heard = !input.stop_hook_active && !endsWithHandback(entries);
  const fail = (where, problem, ask) => (heard
    ? { block: `${problem} ${ask}` }
    : { warn: `bstack: nothing was posted for ${where}. ${problem} Run a fresh ${input.agent_type} agent for it.` });

  const report = reportTexts(input, entries).map(text => parseReport(kind, text)).find(Boolean);
  if (!report) {
    return fail(promptedPr(entries), `The ${input.agent_type} report has no result line.`,
      `End your report with exactly one line:\n${LAST_LINE[kind]}\nThe bstack hook posts it; do not post it yourself.`);
  }
  let pr;
  try {
    pr = JSON.parse(gh(input.cwd, ['pr', 'view', report.pr, '--json', 'number,url,headRefOid,comments']));
  } catch (e) {
    return fail(`PR ${report.pr}`, `bstack could not read PR ${report.pr} (${String(e.message ?? e).split('\n')[0]}).`,
      'Check the PR number and end with the line again.');
  }
  if (pr.headRefOid !== report.sha) {
    return fail(pr.url, `PR ${pr.number} head is now ${pr.headRefOid}, not ${report.sha}.`,
      'Check out the new head, re-check what changed, and end with the line for the new SHA.');
  }
  const body = commentBody(kind, report.result, report.sha, report.body);
  if ((pr.comments ?? []).some(c => String(c.body ?? '').trim() === body.trim())) return {};
  return { post: { pr: pr.url, body } };
}

export const commentArgs = (post, file) => ['pr', 'comment', post.pr, '--body-file', file];

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const gh = (cwd, args) => execFileSync('gh', args, { cwd: cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 64 << 20 });
  const out = handle(input, gh, readSettled);
  if (out.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: out.block }));
    return;
  }
  if (out.warn) {
    process.stdout.write(JSON.stringify({ systemMessage: out.warn }));
    return;
  }
  if (out.post) {
    const file = path.join(os.tmpdir(), `bstack-verdict-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(file, out.post.body, 'utf8');
    try {
      gh(input.cwd, commentArgs(out.post, file));
      process.stdout.write(JSON.stringify({ systemMessage: `bstack: verdict posted on ${out.post.pr}` }));
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`bstack verdict hook failed: ${e.message ?? e}\n`); process.exit(1); });
}
