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

function within(style, dir, target) {
  const rel = style.relative(dir, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel));
}

const POSIX_HOST = {
  isAbsolute: p => path.posix.isAbsolute(p),
  resolvePath: (base, p = '.') => path.posix.resolve(base ?? '', p),
  contains: (dir, target) => within(path.posix, dir, target),
};

const WINDOWS_HOST = {
  isAbsolute(p, dialect = 'posix') {
    return WINDOWS_ABSOLUTE.test(p) || (dialect === 'posix' && POSIX_ABSOLUTE.test(p));
  },
  resolvePath(base, p = '.', dialect = 'posix') {
    if (WINDOWS_ABSOLUTE.test(p)) return path.win32.resolve(p);
    if (base && styleOf(base) === path.posix && POSIX_ABSOLUTE.test(base)) return path.posix.resolve(posixSlashes(base), posixSlashes(p));
    if (dialect !== 'posix') return path.win32.resolve(base ?? '', p);
    if (GIT_BASH_DRIVE.test(p)) return path.win32.resolve(driveLetterForm(p));
    if (POSIX_ABSOLUTE.test(p)) return path.posix.resolve(posixSlashes(p));
    return path.win32.resolve(base ?? '', p);
  },
  contains(dir, target) {
    const style = styleOf(dir);
    const inStyle = inStyleOf(style === path.win32, target);
    return styleOf(inStyle) === style && within(style, dir, inStyle);
  },
};

export function pathsOn(platform) {
  return platform === 'win32' ? WINDOWS_HOST : POSIX_HOST;
}
