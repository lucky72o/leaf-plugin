#!/usr/bin/env node
// /leaf:read's resolver: turns the user's words into candidate markdown files.
//   node find-md.mjs --cwd <dir> <words...>
// Prints one JSON line: {"matches": [{path, score, mtime}, ...]} (best first, at most 10)
// or {"error": "..."} with exit 64. Plain Node 20+, no dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STOP = new Set(['the', 'a', 'an', 'from', 'in', 'of', 'my', 'project', 'file', 'md', 'markdown']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'build', 'dist', 'vendor', '.leaf']);
const MAX_DEPTH = 6;
const MAX_RESULTS = 10;
const BROAD = 'working directory too broad for a search; give a path';

const isMarkdown = (p) => /\.(md|markdown)$/i.test(p);

/// Joins the words, strips surrounding quotes or backticks and a trailing :line or :line:col.
export function cleanWords(words) {
  let s = words.join(' ').trim();
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  s = s.replace(/:\d+(:\d+)?$/, '');
  return s;
}

/// An explicit path (starts with /, ~/ or file:, or contains a slash) resolved to a file,
/// or null when the cleaned words are not an explicit path.
export function explicitPath(cleaned, cwd, home = os.homedir()) {
  let p;
  if (/^file:/i.test(cleaned)) {
    try { p = fileURLToPath(cleaned); } catch { return { error: 'not a file URL' }; }
  } else if (cleaned.startsWith('~/')) {
    p = path.join(home, cleaned.slice(2));
  } else if (cleaned.startsWith('/') || cleaned.includes('/')) {
    p = path.resolve(cwd, cleaned);
  } else {
    return null;
  }
  return checkFile(p);
}

function checkFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return { error: 'no such file: ' + p }; }
  if (!st.isFile()) return { error: 'no such file: ' + p };
  if (!isMarkdown(p)) return { error: 'not a markdown file' };
  return { path: p };
}

/// Lower-cased pieces of letters and digits.
export function tokens(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/// The user's words as search terms: tokenised, stop words dropped.
export function terms(words) {
  return tokens(words.join(' ')).filter(t => !STOP.has(t));
}

function realpathOr(p) { try { return fs.realpathSync(p); } catch { return null; } }

function gitTopLevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/// The project (git top level or cwd) and its sibling directories, or an error when the
/// project is too broad to search. `home` and `fsRoot` are injectable for tests.
export function roots(cwd, { home = os.homedir(), fsRoot = '/' } = {}) {
  const real = realpathOr(cwd);
  if (!real) return { error: '--cwd is not a directory: ' + cwd };
  const top = gitTopLevel(real);
  const project = (top && realpathOr(top)) || real;
  const isRepo = !!top;
  const homeReal = realpathOr(home) || home;
  const rootReal = realpathOr(fsRoot) || fsRoot;
  const parent = path.dirname(project);
  if (project === rootReal || project === homeReal || parent === rootReal) return { error: BROAD };
  let siblings = [];
  if (isRepo && parent !== rootReal && parent !== homeReal && path.dirname(parent) !== rootReal) {
    try {
      siblings = fs.readdirSync(parent, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.isSymbolicLink() && path.join(parent, d.name) !== project && !d.name.startsWith('.'))
        .map(d => path.join(parent, d.name))
        .sort();
    } catch { siblings = []; }
  }
  return { project, siblings };
}

function walk(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude')) continue;
      walk(full, depth + 1, out);
    } else if (e.isFile() && isMarkdown(e.name)) {
      out.push(full);
    }
  }
}

const matchesToken = (term, tok) => term === tok || (term.length >= 3 && tok.includes(term));

/// Candidates under the project and its siblings that match every term, scored and sorted.
export function search({ project, siblings }, termList) {
  const results = [];
  const rootsList = [[project, true], ...siblings.map(s => [s, false])];
  for (const [root, inProject] of rootsList) {
    const files = [];
    walk(root, 0, files);
    const rootParent = path.dirname(root);
    for (const f of files) {
      const rel = path.relative(rootParent, f);
      const nameToks = tokens(path.basename(f));
      const pathToks = tokens(rel);
      let score = inProject ? 2 : 0;
      let ok = true;
      for (const t of termList) {
        if (nameToks.some(tok => matchesToken(t, tok))) score += 3;
        else if (pathToks.some(tok => matchesToken(t, tok))) score += 1;
        else { ok = false; break; }
      }
      if (!ok) continue;
      let mtime = 0;
      try { mtime = fs.statSync(f).mtimeMs; } catch {}
      results.push({ path: f, score, mtime });
    }
  }
  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results.slice(0, MAX_RESULTS).map(r => ({ path: r.path, score: r.score, mtime: new Date(r.mtime).toISOString() }));
}

/// The command: returns {out, code} without printing, so tests can call it.
export function main(argv, env = {}) {
  const words = [];
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') { cwd = argv[++i]; } else words.push(argv[i]);
  }
  if (!cwd) return { out: { error: 'usage: find-md.mjs --cwd <dir> <words...>' }, code: 64 };
  const real = realpathOr(cwd);
  if (!real || !fs.statSync(real).isDirectory()) return { out: { error: '--cwd is not a directory: ' + cwd }, code: 64 };
  if (words.length === 0) return { out: { error: 'no search terms' }, code: 64 };
  const cleaned = cleanWords(words);
  const direct = explicitPath(cleaned, real, env.home);
  if (direct) {
    if (direct.error) return { out: { error: direct.error }, code: 64 };
    return { out: { matches: [found(direct.path)] }, code: 0 };
  }
  // A bare file name that exists in cwd.
  if (isMarkdown(cleaned)) {
    const bare = checkFile(path.join(real, cleaned));
    if (bare.path) return { out: { matches: [found(bare.path)] }, code: 0 };
  }
  const termList = terms(words);
  if (termList.length === 0) return { out: { error: 'no search terms' }, code: 64 };
  const r = roots(real, env);
  if (r.error) return { out: { error: r.error }, code: 64 };
  return { out: { matches: search(r, termList) }, code: 0 };
}

function found(p) {
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch {}
  return { path: p, score: 100, mtime: new Date(mtime).toISOString() };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, code } = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(code);
}
