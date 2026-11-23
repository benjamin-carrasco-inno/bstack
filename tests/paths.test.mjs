import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, contains, isAbsolute } from '../plugins/bstack/scripts/lib/paths.mjs';

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

test('a Git Bash drive path /c/... is the Windows drive when the base is a Windows path', () => {
  assert.equal(resolvePath('C:\\wt', '/c/wt/x.diff'), 'C:\\wt\\x.diff');
  assert.equal(resolvePath('C:\\wt', '/d'), 'D:\\');
  assert.equal(resolvePath('/repo', '/c/wt'), '/c/wt');
  assert.equal(resolvePath('C:\\wt', '/checkout'), '/checkout');
  assert.equal(contains('C:\\wt', '/c/wt/x.diff'), true);
  assert.equal(contains('C:\\wt', '/d/wt/x.diff'), false);
  assert.equal(contains('/c/wt', '/c/wt/x'), true);
});

test('PowerShell and cmd resolve /x against the drive of a Windows base, without Git Bash translation', () => {
  for (const dialect of ['powershell', 'cmd']) {
    assert.equal(resolvePath('C:\\repo', '/tmp/x', dialect), 'C:\\tmp\\x');
    assert.equal(resolvePath('D:/wt', '/c/proj', dialect), 'D:\\c\\proj');
    assert.equal(resolvePath('C:\\repo', 'src', dialect), 'C:\\repo\\src');
    assert.equal(resolvePath('/repo', '/tmp/x', dialect), '/tmp/x');
    assert.equal(isAbsolute('/tmp/x', dialect), false);
    assert.equal(isAbsolute('C:/tmp/x', dialect), true);
  }
  assert.equal(resolvePath('C:\\repo', '/c/proj', 'posix'), 'C:\\proj');
  assert.equal(isAbsolute('/tmp/x'), true);
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
