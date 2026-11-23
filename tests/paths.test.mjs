import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, contains } from '../plugins/bstack/scripts/lib/paths.mjs';

test('a Windows drive path is absolute on every platform', () => {
  assert.equal(resolvePath('C:/repo', 'C:/checkout/src/a.mjs'), 'C:\\checkout\\src\\a.mjs');
  assert.equal(resolvePath('/repo', 'D:\\checkout\\a.mjs'), 'D:\\checkout\\a.mjs');
  assert.equal(resolvePath('C:\\repo', 'src/a.mjs'), 'C:\\repo\\src\\a.mjs');
  assert.equal(resolvePath('C:/repo', '..\\other'), 'C:\\other');
  assert.equal(resolvePath('C:/repo', '//server/share/a'), '\\\\server\\share\\a');
});

test('a POSIX absolute path is absolute on every platform', () => {
  assert.equal(resolvePath('/repo', '/checkout/src/a.mjs'), '/checkout/src/a.mjs');
  assert.equal(resolvePath('C:/repo', '/checkout/src/a.mjs'), '/checkout/src/a.mjs');
  assert.equal(resolvePath('/repo', 'src/a.mjs'), '/repo/src/a.mjs');
  assert.equal(resolvePath('/repo', '..\\other'), '/other');
  assert.equal(resolvePath('/repo'), '/repo');
});

test('contains compares within one path style and refuses across styles', () => {
  assert.equal(contains('C:\\repo', 'C:\\repo'), true);
  assert.equal(contains('C:\\repo', 'c:\\Repo\\src\\a.mjs'), true);
  assert.equal(contains('C:\\repo', 'C:\\checkout\\a.mjs'), false);
  assert.equal(contains('C:\\repo', 'C:\\repo-other\\a.mjs'), false);
  assert.equal(contains('/repo', '/repo/src/a.mjs'), true);
  assert.equal(contains('/repo', '/checkout/a.mjs'), false);
  assert.equal(contains('/repo', '/Repo/a.mjs'), false);
  assert.equal(contains('/repo', 'C:\\repo\\a.mjs'), false);
  assert.equal(contains('C:\\repo', '/repo/a.mjs'), false);
});
