import path from 'node:path';

const WINDOWS_ABSOLUTE = /^([a-z]:[\\/]|[\\/]{2})/i;
const POSIX_ABSOLUTE = /^[\\/]/;

const styleOf = absolute => (WINDOWS_ABSOLUTE.test(absolute) ? path.win32 : path.posix);
const posixSlashes = p => p.replace(/\\/g, '/');

export function isAbsolute(p) {
  return WINDOWS_ABSOLUTE.test(p) || POSIX_ABSOLUTE.test(p);
}

export function resolvePath(base, p = '.') {
  if (WINDOWS_ABSOLUTE.test(p)) return path.win32.resolve(p);
  if (POSIX_ABSOLUTE.test(p)) return path.posix.resolve(posixSlashes(p));
  const from = WINDOWS_ABSOLUTE.test(base) || POSIX_ABSOLUTE.test(base) ? base : path.resolve(base);
  if (styleOf(from) === path.win32) return path.win32.resolve(from, p);
  return path.posix.resolve(posixSlashes(from), posixSlashes(p));
}

export function contains(dir, target) {
  const style = styleOf(dir);
  if (styleOf(target) !== style) return false;
  const rel = style.relative(dir, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel));
}
