import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathsOn } from '../plugins/bstack/scripts/lib/paths.mjs';

const windows = pathsOn('win32');
const posix = pathsOn('linux');

test('on a Windows host a drive or UNC path is absolute in every dialect', () => {
  const { resolvePath } = windows;
  assert.equal(resolvePath('C:/repo', 'C:/checkout/src/a.mjs'), 'C:\\checkout\\src\\a.mjs');
  assert.equal(resolvePath('/repo', 'D:\\checkout\\a.mjs'), 'D:\\checkout\\a.mjs');
  assert.equal(resolvePath('C:\\repo', 'src/a.mjs'), 'C:\\repo\\src\\a.mjs');
  assert.equal(resolvePath('C:/repo', '..\\other'), 'C:\\other');
  assert.equal(resolvePath('C:/repo', '//server/share/a'), '\\\\server\\share\\a');
});

test('on a Windows host Bash keeps a POSIX path that is not a drive in POSIX style', () => {
  const { resolvePath } = windows;
  assert.equal(resolvePath('/repo', '/checkout/src/a.mjs'), '/checkout/src/a.mjs');
  assert.equal(resolvePath('C:/repo', '/checkout/src/a.mjs'), '/checkout/src/a.mjs');
  assert.equal(resolvePath('/repo', 'src/a.mjs'), '/repo/src/a.mjs');
  assert.equal(resolvePath('/repo', '..\\other'), '/other');
  assert.equal(resolvePath('/repo'), '/repo');
});

test('on a Windows host a Git Bash drive path /c/... is the Windows drive when the base is a Windows path', () => {
  const { resolvePath, contains } = windows;
  assert.equal(resolvePath('C:\\wt', '/c/wt/x.diff'), 'C:\\wt\\x.diff');
  assert.equal(resolvePath('C:\\wt', '/d'), 'D:\\');
  assert.equal(resolvePath('/repo', '/c/wt'), '/c/wt');
  assert.equal(resolvePath('C:\\wt', '/checkout'), '/checkout');
  assert.equal(contains('C:\\wt', '/c/wt/x.diff'), true);
  assert.equal(contains('C:\\wt', '/d/wt/x.diff'), false);
  assert.equal(contains('/c/wt', '/c/wt/x'), true);
});

test('on a Windows host a Git Bash drive path is the drive even when the base is unknown, whatever the process cwd', () => {
  const { resolvePath } = windows;
  assert.equal(resolvePath('', '/c/wt'), 'C:\\wt');
  assert.equal(resolvePath(undefined, '/d/x'), 'D:\\x');
  assert.equal(resolvePath('', '/checkout'), '/checkout');
});

test('on a Windows host PowerShell and cmd resolve /x against the drive of a Windows base, without Git Bash translation', () => {
  const { resolvePath, isAbsolute } = windows;
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

test('on a Windows host contains compares within one path style and refuses across styles', () => {
  const { contains } = windows;
  assert.equal(contains('C:\\repo', 'C:\\repo'), true);
  assert.equal(contains('C:\\repo', 'c:\\Repo\\src\\a.mjs'), true);
  assert.equal(contains('C:\\repo', 'C:\\checkout\\a.mjs'), false);
  assert.equal(contains('C:\\repo', 'C:\\repo-other\\a.mjs'), false);
  assert.equal(contains('/repo', '/repo/src/a.mjs'), true);
  assert.equal(contains('/repo', '/checkout/a.mjs'), false);
  assert.equal(contains('/repo', 'C:\\repo\\a.mjs'), false);
  assert.equal(contains('C:\\repo', '/repo/a.mjs'), false);
});

test('on a POSIX host every dialect resolves as path.posix: //x is /x, no drive letters, no UNC', () => {
  const { resolvePath, isAbsolute } = posix;
  for (const dialect of ['posix', 'powershell', 'cmd']) {
    assert.equal(resolvePath('/home/u/repo', '//home/u/wt', dialect), '/home/u/wt');
    assert.equal(resolvePath('/home/u/repo', '/home/u/wt', dialect), '/home/u/wt');
    assert.equal(resolvePath('/home/u/repo', '../wt', dialect), '/home/u/wt');
    assert.equal(resolvePath('/home/u/repo', '/c/wt', dialect), '/c/wt');
    assert.equal(resolvePath('/home/u/repo', 'C:\\wt', dialect), '/home/u/repo/C:\\wt');
    assert.equal(isAbsolute('/home/u/wt', dialect), true);
    assert.equal(isAbsolute('//home/u/wt', dialect), true);
    assert.equal(isAbsolute('C:\\wt', dialect), false);
    assert.equal(isAbsolute('\\\\srv\\share', dialect), false);
  }
});

test('on a POSIX host contains is path.posix containment, case-sensitive', () => {
  const { contains } = posix;
  assert.equal(contains('/repo', '/repo'), true);
  assert.equal(contains('/repo', '/repo/src/a.mjs'), true);
  assert.equal(contains('/repo', '/checkout/a.mjs'), false);
  assert.equal(contains('/repo', '/repo-other/a.mjs'), false);
  assert.equal(contains('/repo', '/Repo/a.mjs'), false);
});
