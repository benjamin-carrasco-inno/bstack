import path from 'node:path';

const WINDOWS_ABSOLUTE = /^([a-z]:[\\/]|[\\/]{2})/i;
const POSIX_ABSOLUTE = /^[\\/]/;
const GIT_BASH_DRIVE = /^\/([a-z])(\/|$)/i;

const styleOf = absolute => (WINDOWS_ABSOLUTE.test(absolute) ? path.win32 : path.posix);
const posixSlashes = p => p.replace(/\\/g, '/');
const driveLetterForm = p => p.replace(GIT_BASH_DRIVE, (_, drive) => `${drive.toUpperCase()}:/`);

function inStyleOf(windows, p) {
  return windows && GIT_BASH_DRIVE.test(p) ? path.win32.resolve(driveLetterForm(p)) : p;
}

export function isAbsolute(p) {
  return WINDOWS_ABSOLUTE.test(p) || POSIX_ABSOLUTE.test(p);
}

export function resolvePath(base, p = '.') {
  if (WINDOWS_ABSOLUTE.test(p)) return path.win32.resolve(p);
  const from = base === undefined || isAbsolute(base) ? base : path.resolve(base);
  const windows = from !== undefined && styleOf(from) === path.win32;
  if (POSIX_ABSOLUTE.test(p)) return windows && GIT_BASH_DRIVE.test(p) ? path.win32.resolve(driveLetterForm(p)) : path.posix.resolve(posixSlashes(p));
  if (windows) return path.win32.resolve(from, p);
  return path.posix.resolve(posixSlashes(from), posixSlashes(p));
}

export function contains(dir, target) {
  const style = styleOf(dir);
  const inStyle = inStyleOf(style === path.win32, target);
  if (styleOf(inStyle) !== style) return false;
  const rel = style.relative(dir, inStyle);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel));
}
