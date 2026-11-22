#!/usr/bin/env node
/*
 * Rewrite the FILES list in docs/sw.js from what is actually on disk, so offline play always matches the
 * game (tests/sw.test.mjs fails whenever the two disagree). Run it after adding, renaming or removing any
 * code/art file under docs/ (not the backgrounds: those are cached lazily):
 *
 *   node tools/sync-sw.mjs            # rewrite FILES
 *   node tools/sync-sw.mjs --bump     # ...and bump VERSION too (phones fetch the new files)
 *   node tools/sync-sw.mjs --check    # change nothing; exit 1 if sw.js is out of date
 */
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

export function rewrite(source, list, { bump = false } = {}) {
  const block = `const FILES = [\n${list.map((f) => `  '${f}',`).join('\n')}\n];`;
  let out = source.replace(/const FILES = \[[\s\S]*?\n\];/, block);
  if (bump) {
    out = out.replace(/const VERSION = PREFIX \+ '([^']*)';/, (m, v) => {
      const n = /^v(\d+)$/.exec(v);
      return `const VERSION = PREFIX + '${n ? `v${Number(n[1]) + 1}` : `${v}-${Date.now().toString(36)}`}';`;
    });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const source = fs.readFileSync(swPath, 'utf8');
  const next = rewrite(source, precacheList(walk(docs)), { bump: args.has('--bump') });
  if (args.has('--check')) {
    if (next === source) console.log('sw.js FILES is up to date');
    else { console.error('sw.js FILES is out of date: run  node tools/sync-sw.mjs'); process.exit(1); }
  } else if (next === source) console.log('sw.js already up to date');
  else { fs.writeFileSync(swPath, next); console.log('sw.js updated'); }
}
