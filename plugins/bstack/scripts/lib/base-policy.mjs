// Policy files come from the PR's base branch: neither the PR nor the local checkout may loosen them.

const FILE_OR_REPO_NOT_FOUND = /\bNot Found \(HTTP 404\)/;

export function readBasePolicy(gh, repo, base, file) {
  if (!repo || !base) throw new Error(`the PR names no ${repo ? 'base branch' : 'repository'}`);
  try {
    return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file}?ref=${encodeURIComponent(base)}`]);
  } catch (e) {
    if (!FILE_OR_REPO_NOT_FOUND.test(`${e?.message ?? e}\n${e?.stderr ?? ''}`)) throw e;
    gh(['api', '--jq', '.full_name', `repos/${repo}`]);
    return '';
  }
}

export const policyLines = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
