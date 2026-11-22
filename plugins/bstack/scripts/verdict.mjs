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

// Returns { post: { pr, body } } or { block: reason } or {}.
export function handle(input, gh) {
  const kind = kindOf(String(input.agent_type ?? ''));
  if (!kind) return {};
  const again = Boolean(input.stop_hook_active);
  const report = parseReport(kind, input.last_assistant_message);
  if (!report) {
    return again ? {} : { block: `End your report with exactly one line:\n${LAST_LINE[kind]}\nThe bstack hook posts it; do not post it yourself.` };
  }
  let pr;
  try {
    pr = JSON.parse(gh(input.cwd, ['pr', 'view', report.pr, '--json', 'number,url,headRefOid']));
  } catch (e) {
    return again ? {} : { block: `bstack could not read PR ${report.pr} (${String(e.message ?? e).split('\n')[0]}). Check the PR number and end with the line again.` };
  }
  if (pr.headRefOid !== report.sha) {
    return again ? {} : { block: `PR ${pr.number} head is now ${pr.headRefOid}, not ${report.sha}. Check out the new head, re-check what changed, and end with the line for the new SHA.` };
  }
  return { post: { pr: pr.url, body: commentBody(kind, report.result, report.sha, report.body) } };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const gh = (cwd, args) => execFileSync('gh', args, { cwd: cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 });
  const out = handle(input, gh);
  if (out.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: out.block }));
    return;
  }
  if (out.post) {
    const file = path.join(os.tmpdir(), `bstack-verdict-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(file, out.post.body, 'utf8');
    try {
      gh(input.cwd, ['pr', 'comment', out.post.pr, '--body-file', file]);
      process.stdout.write(JSON.stringify({ systemMessage: `bstack: verdict posted on ${out.post.pr}` }));
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`bstack verdict hook failed: ${e.message ?? e}\n`); process.exit(1); });
}
