import path from 'node:path';

const VALUED_GLOBALS = new Set(['--color', '--config', '--manifest-path', '--explain', '-Z', '-C']);

export const isCargo = program => /^cargo(\.exe)?$/i.test(path.basename(String(program ?? '').replace(/\\/g, '/')));

export function cargoSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUED_GLOBALS.has(a)) i++;
    else if (!a.startsWith('-') && !a.startsWith('+')) return a;
  }
  return undefined;
}

export const holdsNoLock = subcommand => /^(run|r)$/.test(subcommand ?? '');
