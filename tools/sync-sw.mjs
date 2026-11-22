#!/usr/bin/env node
/*
 * Rewrite the FILES list AND the VERSION in docs/sw.js from what is actually on disk, so offline play always
 * matches the game. Run it as the LAST step before every release, after any change under docs/ (not the
 * backgrounds: those are cached lazily):
 *
 *   node tools/sync-sw.mjs            # rewrite FILES and VERSION
 *   node tools/sync-sw.mjs --check    # change nothing; exit 1 if sw.js is out of date
 *
 * VERSION is a fingerprint of the content of every cached file, so it changes exactly when a file changes.
 * Nobody has to remember to "bump" it: a phone that already has the game keeps its old copy for ever unless
 * VERSION changes, and tests/sw.test.mjs fails whenever the fingerprint is stale. (--bump is still accepted
 * and does the same thing.)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const swPath = path.join(docs, 'sw.js');

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}

/** Pages first, then code, then icons; everything else (not assets/, not sw.js, not dotfiles) in sorted order. */
export function precacheList(onDisk) {
  const files = onDisk.filter((f) => !f.startsWith('assets/') && f !== 'sw.js' && !f.split('/').some((p) => p.startsWith('.')));
  const rank = (f) => (['index.html', 'style.css', 'manifest.webmanifest'].indexOf(f) + 1 || (f.startsWith('js/') ? 10 : f.startsWith('icons/') ? 20 : 15));
  return ['./', ...files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((f) => `./${f}`)];
}

const FILES_BLOCK = /const FILES = \[[\s\S]*?\n\];/;
const VERSION_LINE = /const VERSION = PREFIX \+ '[^']*';/;

/**
 * Fingerprint of everything a phone would keep: each listed file's path and bytes, plus the worker's own logic
 * (sw.js with its FILES block and VERSION line blanked out, because those are what this fingerprint feeds).
 * `read(relPath)` returns a Buffer or string for a path like 'js/ui.mjs'.
 */
export function contentVersion(list, swSource, read) {
  const h = crypto.createHash('sha1');
  for (const f of list) {
    if (f === './') continue;                                     // the page itself is index.html
    h.update(f); h.update('\0'); h.update(read(f.slice(2))); h.update('\0');
  }
  h.update(swSource.replace(FILES_BLOCK, '').replace(VERSION_LINE, ''));
  return 'v-' + h.digest('hex').slice(0, 10);
}

export function rewrite(source, list, read) {
  const block = `const FILES = [\n${list.map((f) => `  '${f}',`).join('\n')}\n];`;
  const withFiles = source.replace(FILES_BLOCK, block);
  const version = contentVersion(list, withFiles, read);
  return withFiles.replace(VERSION_LINE, `const VERSION = PREFIX + '${version}';`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const source = fs.readFileSync(swPath, 'utf8');
  const next = rewrite(source, precacheList(walk(docs)), (rel) => fs.readFileSync(path.join(docs, rel)));
  if (args.has('--check')) {
    if (next === source) console.log('sw.js FILES and VERSION are up to date');
    else { console.error('sw.js FILES / VERSION are out of date (a file was added, removed or edited): run  node tools/sync-sw.mjs'); process.exit(1); }
  } else if (next === source) console.log('sw.js already up to date');
  else { fs.writeFileSync(swPath, next); console.log('sw.js updated'); }
}
