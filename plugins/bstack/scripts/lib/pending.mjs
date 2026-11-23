// Verdicts the SubagentStop hook could not post because GitHub did not answer. The guard posts them at
// the next merge of that PR. Agents may not write here; the guard blocks paths matching PENDING_NAME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PENDING_NAME = /pending-verdicts/i;
export const PENDING_DIR = path.join(os.homedir(), '.claude', 'bstack', 'pending-verdicts');

const slug = s => String(s).toLowerCase().replace(/[^\w.-]+/g, '_');
const prefix = (repo, pr) => `${slug(repo)}__${slug(pr)}__`;

export const repoOfUrl = url => /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/i.exec(String(url ?? ''))?.[1] ?? null;

export function pendingStore(dir = PENDING_DIR) {
  return {
    save(entry) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${prefix(entry.repo, entry.pr)}${slug(entry.sha)}__${slug(entry.kind)}.json`);
      fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
      return file;
    },
    list(repo, pr) {
      let names;
      try { names = fs.readdirSync(dir); } catch { return []; }
      return names.filter(n => n.startsWith(prefix(repo, pr))).flatMap(n => {
        const file = path.join(dir, n);
        try {
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          return slug(entry.repo) === slug(repo) && String(entry.pr) === String(pr) ? [{ file, entry }] : [];
        } catch { return []; }
      });
    },
    remove(file) { fs.rmSync(file, { force: true }); },
  };
}
