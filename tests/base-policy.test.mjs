import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBasePolicy } from '../plugins/bstack/scripts/lib/base-policy.mjs';

const ghFailure = stderr => Object.assign(new Error(`Command failed: gh api\n${stderr}\n`), { status: 1, stderr: `${stderr}\n` });
const FILE_OR_REPO_MISSING = 'gh: Not Found (HTTP 404)';
const REF_MISSING = 'gh: No commit found for the ref gone (HTTP 404)';

function github({ repos = { 'o/r': { main: { '.github/risk-paths.txt': 'app/*.py\n' } } } } = {}) {
  return args => {
    const endpoint = args.at(-1);
    const read = /^repos\/([\w.-]+\/[\w.-]+)\/contents\/(.+)\?ref=(.+)$/.exec(endpoint);
    const repo = repos[read ? read[1] : endpoint.replace(/^repos\//, '')];
    if (!repo) throw ghFailure(FILE_OR_REPO_MISSING);
    if (!read) return 'o/r\n';
    const files = repo[decodeURIComponent(read[3])];
    if (!files) throw ghFailure(REF_MISSING);
    if (files[read[2]] === undefined) throw ghFailure(FILE_OR_REPO_MISSING);
    return files[read[2]];
  };
}

test('readBasePolicy returns the base file, and empty when only the file is missing', () => {
  assert.equal(readBasePolicy(github(), 'o/r', 'main', '.github/risk-paths.txt'), 'app/*.py\n');
  assert.equal(readBasePolicy(github(), 'o/r', 'main', '.github/bstack-exposure.txt'), '');
});

test('readBasePolicy fails closed for a missing base ref or a missing repository', () => {
  assert.throws(() => readBasePolicy(github(), 'o/r', 'gone', '.github/risk-paths.txt'), /No commit found for the ref gone \(HTTP 404\)/);
  assert.throws(() => readBasePolicy(github(), 'o/gone', 'main', '.github/risk-paths.txt'), /Not Found \(HTTP 404\)/);
});

test('readBasePolicy fails closed for any other gh failure', () => {
  for (const failure of ['gh: Server Error (HTTP 502)', 'gh: Bad credentials (HTTP 401)', 'error connecting to api.github.com']) {
    assert.throws(() => readBasePolicy(() => { throw ghFailure(failure); }, 'o/r', 'main', '.github/risk-paths.txt'), new RegExp(failure.replace(/[()]/g, '\\$&')));
  }
});
