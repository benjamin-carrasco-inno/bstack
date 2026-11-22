#!/usr/bin/env node
// @ts-check
/* Copyright (c) 2026 Example Authors.
 * Licensed under the MIT licence. */

import fs from 'node:fs';

/**
 * Reads a file.
 */
export function read(file) {
  const url = 'https://example.com/a//b'; // a trailing comment
  const glob = "src/**/*.js";
  const re = /\/\/ not a comment/g;
  const half = 10 / 2; /* inline block */
  const tpl = `// inside a template ${file} /* still text */`;
  // eslint-disable-next-line no-console
  console.log(url, glob, re, half, tpl);
  return fs.readFileSync(file, 'utf8');
}
