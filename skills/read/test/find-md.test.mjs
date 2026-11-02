import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cleanWords, explicitPath, terms, tokens, roots, search, main } from '../find-md.mjs';

const BROAD = 'working directory too broad for a search; give a path';

/// A fresh tree. `fsRoot` is the temp dir itself, so "a child of the filesystem root"
/// is a direct child of it, and `home` is a directory inside it.
function tree() {
  const fsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-md-')));
  const home = path.join(fsRoot, 'home', 'me');
  fs.mkdirSync(home, { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  return { fsRoot, home, work };
}
function file(p, text = '# doc\n', mtime) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}
function repo(dir) { fs.mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: dir }); return dir; }
function find(cwd, words, env) {
  const r = roots(cwd, env);
  if (r.error) return r;
  return { matches: search(r, terms(words)) };
}
const paths = (res) => res.matches.map(m => m.path);

test('literal path: quotes, file URL with encoded space, :line:col', () => {
  const t = tree();
  const f = file(path.join(t.work, 'release plan.md'));
  const url = pathToFileURL(f).href + ':12:3';
  const cleaned = cleanWords(['`' + url + '`']);
  assert.deepEqual(explicitPath(cleaned, t.work), { path: f });
  const r = main(['--cwd', t.work, '"' + f + '"']);
  assert.equal(r.code, 0);
  assert.equal(r.out.matches[0].path, f);
  assert.equal(r.out.matches[0].score, 100);
  // localhost form and a non-ASCII name
  const g = file(path.join(t.work, 'план.md'));
  const local = 'file://localhost' + encodeURI(g);
  assert.deepEqual(explicitPath(cleanWords([local]), t.work), { path: g });
  // ~/ expansion
  const h = file(path.join(t.home, 'notes.md'));
  assert.deepEqual(explicitPath('~/notes.md', t.work, t.home), { path: h });
});

test('explicit missing path never searches', () => {
  const t = tree();
  file(path.join(t.work, 'docs', 'release-plan-draft.md'));
  const r = main(['--cwd', t.work, 'docs/release-plan.md']);
  assert.equal(r.code, 64);
  assert.equal(r.out.error, 'no such file: ' + path.join(t.work, 'docs', 'release-plan.md'));
  const bad = main(['--cwd', t.work, 'file:///%zz']);
  assert.equal(bad.code, 64);
  assert.equal(bad.out.error, 'not a file URL');
});

test('explicit non-markdown file', () => {
  const t = tree();
  file(path.join(t.work, 'notes.txt'));
  const r = main(['--cwd', t.work, './notes.txt']);
  assert.equal(r.code, 64);
  assert.equal(r.out.error, 'not a markdown file');
});

test('bare non-markdown file name in cwd is refused, not searched', () => {
  const t = tree();
  file(path.join(t.work, 'notes.txt'));
  file(path.join(t.work, 'docs', 'notes-txt.md'));
  const r = main(['--cwd', t.work, 'notes.txt']);
  assert.equal(r.code, 64);
  assert.equal(r.out.error, 'not a markdown file');
  // a bare name that does not exist goes on to the search
  const g = main(['--cwd', t.work, 'notes']);
  assert.equal(g.code, 0);
  assert.deepEqual(paths(g.out), [path.join(t.work, 'docs', 'notes-txt.md')]);
});

test('unreadable files are skipped', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const ok = file(path.join(t.work, 'a', 'plan.md'));
  const locked = file(path.join(t.work, 'b', 'plan.md'));
  fs.chmodSync(locked, 0o000);
  try { assert.deepEqual(paths(find(t.work, ['plan'], env)), [ok]); }
  finally { fs.chmodSync(locked, 0o644); }
});

test('bare file name in cwd', () => {
  const t = tree();
  const f = file(path.join(t.work, 'README.md'));
  file(path.join(t.work, 'docs', 'README.md'));
  const r = main(['--cwd', t.work, 'README.md']);
  assert.deepEqual(paths(r.out), [f]);
  assert.equal(r.out.matches[0].score, 100);
});

test('no search terms', () => {
  const t = tree();
  const r = main(['--cwd', t.work, 'the', 'file']);
  assert.equal(r.code, 64);
  assert.equal(r.out.error, 'no search terms');
  assert.deepEqual(terms(['Daily-Plan.md', 'from', 'the', 'X', 'project']), ['daily', 'plan', 'x']);
  assert.deepEqual(tokens('sleepeasy/docs/daily-plan.md'), ['sleepeasy', 'docs', 'daily', 'plan', 'md']);
});

test('too broad', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  assert.equal(roots(t.home, env).error, BROAD);
  assert.equal(roots(t.fsRoot, env).error, BROAD);
  assert.equal(roots(path.join(t.fsRoot, 'home'), env).error, BROAD);
  const alias = path.join(t.fsRoot, 'alias');
  fs.symlinkSync(t.home, alias);
  assert.equal(roots(alias, env).error, BROAD);
  assert.equal(roots(t.work, env).error, undefined);
});

test('git top level, not a .git marker', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const r = repo(path.join(t.work, 'proj'));
  const sub = path.join(r, 'docs', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(roots(sub, env).project, r);
  const fake = path.join(t.work, 'fake');
  fs.mkdirSync(path.join(fake, '.git'), { recursive: true });
  const fr = roots(fake, env);
  assert.equal(fr.project, fake);
  assert.deepEqual(fr.siblings, []);
  file(path.join(r, 'a.md'));
  execFileSync('git', ['add', '.'], { cwd: r });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: r });
  const wt = path.join(t.work, 'proj-wt');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: r });
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
  assert.equal(roots(wt, env).project, wt);
});

test('no siblings when the project parent is home, fsRoot or a child of fsRoot', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  for (const parent of [t.home, path.join(t.fsRoot, 'opt')]) {
    const r = repo(path.join(parent, 'proj'));
    file(path.join(parent, 'other', 'x.md'));
    const res = roots(r, env);
    assert.equal(res.project, r);
    assert.deepEqual(res.siblings, [], parent);
  }
  // A project directly under the filesystem root is itself too broad.
  assert.equal(roots(repo(path.join(t.fsRoot, 'proj')), env).error, BROAD);
  const r = repo(path.join(t.work, 'proj'));
  file(path.join(t.work, 'other', 'x.md'));
  assert.deepEqual(roots(r, env).siblings, [path.join(t.work, 'other')]);
});

test('terms match project name of a sibling', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const proj = repo(path.join(t.work, 'proj'));
  const f = file(path.join(t.work, 'sleepeasy', 'docs', 'daily-plan.md'));
  file(path.join(t.work, 'pilcrino', 'docs', 'daily-plan.md'));
  assert.deepEqual(paths(find(proj, ['daily', 'plan', 'from', 'the', 'sleepeasy', 'project'], env)), [f]);
});

test('.markdown files', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const f = file(path.join(t.work, 'notes.markdown'));
  assert.deepEqual(explicitPath('./notes.markdown', t.work), { path: f });
  const g = file(path.join(t.work, 'docs', 'plan.markdown'));
  assert.deepEqual(paths(find(t.work, ['plan'], env)), [g]);
});

test('all terms required, no partial', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  file(path.join(t.work, 'daily-plan.md'));
  assert.deepEqual(paths(find(t.work, ['daily', 'plan', 'budget'], env)), []);
});

test('exact scores', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const proj = repo(path.join(t.work, 'proj'));
  const a = file(path.join(proj, 'docs', 'daily-plan.md'));
  const b = file(path.join(t.work, 'x', 'daily', 'plan.md'));
  const res = find(proj, ['daily', 'plan'], env);
  assert.deepEqual(res.matches.map(m => [m.path, m.score]), [[a, 8], [b, 4]]);
  // an exact tie: newer first
  const old = new Date('2020-01-01'), newer = new Date('2021-01-01');
  const c = file(path.join(proj, 'notes', 'one.md'), '# x', old);
  const d = file(path.join(proj, 'notes', 'two.md'), '# x', newer);
  assert.deepEqual(paths(find(proj, ['notes'], env)), [d, c]);
});

test('case insensitive', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const f = file(path.join(t.work, 'daily-plan.md'));
  assert.deepEqual(paths(find(t.work, ['Daily', 'Plan'], env)), [f]);
});

test('unicode tokens', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const f = file(path.join(t.work, 'план.md'));
  assert.deepEqual(paths(find(t.work, ['План'], env)), [f]);
  // a decomposed file name matches a composed query
  const g = file(path.join(t.work, 'cafe\u0301-notes.md'));
  assert.deepEqual(paths(find(t.work, ['café', 'notes'], env)), [g]);
});

test('substring needs 3 chars', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const f = file(path.join(t.work, 'planning.md'));
  assert.deepEqual(paths(find(t.work, ['pl'], env)), []);
  assert.deepEqual(paths(find(t.work, ['plan'], env)), [f]);
});

test('depth 6 included, depth 7 excluded', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const six = file(path.join(t.work, 'a', 'b', 'c', 'd', 'e', 'f', 'plan.md'));
  file(path.join(t.work, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'plan.md'));
  assert.deepEqual(paths(find(t.work, ['plan'], env)), [six]);
});

test('skips .leaf, node_modules, dot dirs except .claude, symlinks', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const keep = file(path.join(t.work, '.claude', 'plan.md'));
  file(path.join(t.work, '.leaf', 'plan.1.r2.revision.md'));
  file(path.join(t.work, 'node_modules', 'x', 'plan.md'));
  file(path.join(t.work, '.hidden', 'plan.md'));
  file(path.join(t.work, 'build', 'plan.md'));
  const outside = file(path.join(t.fsRoot, 'elsewhere', 'plan.md'));
  fs.symlinkSync(path.dirname(outside), path.join(t.work, 'linkdir'));
  fs.symlinkSync(outside, path.join(t.work, 'link-plan.md'));
  assert.deepEqual(paths(find(t.work, ['plan'], env)), [keep]);
  // the same names as sibling roots are skipped too, and .claude is kept
  const proj = repo(path.join(t.work, 'proj'));
  for (const d of ['node_modules', 'build', 'dist', 'vendor', '.hidden']) file(path.join(t.work, d, 'sib.md'));
  const dotClaude = file(path.join(t.work, '.claude', 'sib.md'));
  assert.deepEqual(paths(find(proj, ['sib'], env)), [dotClaude]);
});

test('sibling folder without git', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const proj = repo(path.join(t.work, 'proj'));
  const f = file(path.join(t.work, 'notes', 'ideas.md'));
  assert.deepEqual(paths(find(proj, ['ideas'], env)), [f]);
});

test('no siblings for a non-repo cwd', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  const plain = path.join(t.work, 'plain');
  fs.mkdirSync(plain);
  file(path.join(t.work, 'notes', 'ideas.md'));
  assert.deepEqual(paths(find(plain, ['ideas'], env)), []);
});

test('at most 10 matches', () => {
  const t = tree();
  const env = { home: t.home, fsRoot: t.fsRoot };
  for (let i = 0; i < 12; i++) file(path.join(t.work, 'n' + i, 'plan.md'));
  assert.equal(find(t.work, ['plan'], env).matches.length, 10);
});

test('main prints one JSON line and exit code', () => {
  const t = tree();
  const f = file(path.join(t.work, 'docs', 'daily-plan.md'));
  const out = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'find-md.mjs'), '--cwd', t.work, 'daily', 'plan'], { encoding: 'utf8' });
  assert.equal(out.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(out).matches.map(m => m.path), [f]);
  assert.equal(main([]).code, 64);
  assert.equal(main(['--cwd', path.join(t.work, 'missing'), 'x']).code, 64);
});
