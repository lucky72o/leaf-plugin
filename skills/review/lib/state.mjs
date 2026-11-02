// The skill's state machine: start, wait, publish, done. Every transition that reads
// one file and writes another runs under the lock; interrupted transitions are
// finished by the next start. See the design's "Protocol rules" and state table.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './paths.mjs';
import { hashFile, hashText, decodeText } from './hash.mjs';
import { acquireLock } from './lock.mjs';
import { writeJSONAtomic, readJSON, writeTextAtomic } from './files.mjs';
import { renderComments } from './render.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const exists = (f) => fs.existsSync(f);
const nowISO = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function readDoc(docPath) { return decodeText(fs.readFileSync(docPath)); }

// The comments file "belongs" to the review when the ids match; "behind" when its
// round is lower than the review's (Leaf has not written since the advance).
function roundComments(comments, review) {
  if (!comments || !review || comments.reviewId !== review.reviewId) return null;
  if (comments.round !== review.round) return null;
  return comments;
}

function commentsOfRound(comments, round) {
  return (comments.comments || []).filter(c => c.round === round);
}

function displayName(docPath) {
  // Path relative to the repo root when there is one, else the file name.
  const root = findRepoRoot(path.dirname(docPath));
  return root ? path.relative(root, docPath) : path.basename(docPath);
}

function findRepoRoot(dir) {
  let d = dir;
  for (;;) {
    if (exists(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function ensureGitignore(docPath) {
  const root = findRepoRoot(path.dirname(docPath));
  if (!root) return;
  const file = path.join(root, '.gitignore');
  if (!exists(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.split('\n').some(l => l.trim() === '.leaf/' || l.trim() === '.leaf')) return;
  fs.appendFileSync(file, (text.endsWith('\n') || text === '' ? '' : '\n') + '.leaf/\n');
}

function removeWorkingFiles(p, id) {
  for (const entry of fs.readdirSync(p.folder)) {
    if (entry.startsWith(`${p.name}.${id}.`) || entry.startsWith(`${p.name}.backup.`)) {
      fs.rmSync(path.join(p.folder, entry), { force: true });
    }
  }
}

function archiveComments(p, id) {
  if (!exists(p.comments)) return;
  let attempt = 0;
  while (exists(p.archive(id, attempt))) attempt++;
  fs.renameSync(p.comments, p.archive(id, attempt));
}

// Steps 2 to 4 of ending, shared by done and by start finding an ending marker.
// Returns false when aborted after step `abortAfter`.
function finishEnding(p, id, abortAfter) {
  archiveComments(p, id);
  if (abortAfter === 2) return false;
  removeWorkingFiles(p, id);
  if (abortAfter === 3) return false;
  fs.rmSync(p.endingMarker, { force: true });
  return true;
}

// Keeps every text a publish replaces: <name>.backup.N.md, then -2, -3 for retries.
function backupDocument(p, docPath, round) {
  const target = p.backup(round);
  if (exists(target)) {
    let n = 2;
    while (exists(target.replace(/\.md$/, '-' + n + '.md'))) n++;
    fs.renameSync(target, target.replace(/\.md$/, '-' + n + '.md'));
  }
  // Copy to a temp name and rename, so a backup either exists complete or not at all.
  const tmp = target + '.' + process.pid + '.tmp';
  fs.copyFileSync(docPath, tmp);
  fs.renameSync(tmp, target);
}

// The backup for `round` holds the text with `expectedHash`; a leftover from an
// interrupted copy (or one for another attempt) does not count.
function backupIsComplete(p, round, expectedHash) {
  return exists(p.backup(round)) && hashFile(p.backup(round)) === expectedHash;
}

// Steps 2 to 4 of publishing (the review file for N+1 is already in place).
// `fresh` means this is a new attempt whose input must be backed up even when an
// earlier attempt left a backup; recovery of an interrupted attempt keeps that one.
function finishPublish(p, docPath, id, round, abortAfter, fresh) {
  if (fresh || !backupIsComplete(p, round, hashFile(docPath))) backupDocument(p, docPath, round);
  if (abortAfter === 2) return false;
  fs.renameSync(p.staged(id, round), docPath);
  if (abortAfter === 3) return false;
  fs.rmSync(p.replies(id, round), { force: true });
  return true;
}

// The revision is already the document (or Leaf already entered the round on it):
// nothing to move, only the working files to clear and a backup to keep if possible.
function settlePublishWithoutMove(p, id, round, review) {
  if (!exists(p.backup(round)) && review.previousSnapshot != null && hashText(review.previousSnapshot) === review.baseTextHash) {
    writeTextAtomic(p.backup(round), review.previousSnapshot);
  }
  fs.rmSync(p.staged(id, round), { force: true });
  fs.rmSync(p.replies(id, round), { force: true });
}

async function withLock(p, fn) {
  fs.mkdirSync(p.folder, { recursive: true });
  const release = await acquireLock(p.lock);
  try { return await fn(); } finally { release(); }
}

export async function start(docPath, id, { owner = 'claude', abortAfter } = {}) {
  const p = paths(docPath);
  docPath = p.document;
  if (!exists(docPath)) return { action: 'error', message: 'no such file: ' + docPath, code: 1 };
  return withLock(p, async () => {
    // An interrupted ending comes first.
    const marker = readJSON(p.endingMarker);
    if (marker) {
      if (exists(p.review) && readJSON(p.review)?.reviewId === marker.reviewId) fs.rmSync(p.review, { force: true });
      finishEnding(p, marker.reviewId, undefined);
    }
    let review = readJSON(p.review);
    // An interrupted publish: review N+1 whose hash equals the staged file for round N.
    // Only the owner finishes it, and only while the document is still the text that
    // publish verified (or already the revision); otherwise nothing is touched.
    if (review && review.round > 1 && id === review.reviewId) {
      const prevRound = review.round - 1;
      const staged = p.staged(review.reviewId, prevRound);
      if (exists(staged) && hashFile(staged) === review.textHash) {
        const actual = hashFile(docPath);
        const c = readJSON(p.comments);
        const entered = c && c.reviewId === review.reviewId && (c.enteredRounds || []).includes(review.round);
        if (entered || actual === review.textHash) {
          // Leaf has already shown round N+1 (an unchanged revision lets it enter before
          // the move), or the document already is the revision: never rewind.
          settlePublishWithoutMove(p, review.reviewId, prevRound, review);
        } else if (actual === review.baseTextHash) {
          finishPublish(p, docPath, review.reviewId, prevRound, undefined, false);
        } else {
          // The document changed while publish was interrupted. Put the review file back
          // to round N, complete with its own previous snapshot and replies (kept in
          // N+1's priorRound), so the normal 'changed' recovery applies: publish again
          // with --expect. The replies file for round N is still there.
          const prior = review.priorRound || {};
          const restored = { version: 1, reviewId: review.reviewId, file: review.file, round: review.round - 1, startedAt: review.startedAt,
                             owner: review.owner, textHash: review.previousTextHash, snapshot: review.previousSnapshot,
                             previousTextHash: prior.previousTextHash, previousSnapshot: prior.previousSnapshot, replies: prior.replies,
                             baseTextHash: prior.baseTextHash, priorRound: prior.priorRound };
          for (const k of Object.keys(restored)) if (restored[k] === undefined) delete restored[k];
          writeJSONAtomic(p.review, restored);
          return { action: 'changed', reviewId: review.reviewId, round: restored.round, code: 8, expected: review.baseTextHash, actual, staged,
                   message: 'publish was interrupted and the document changed since. The staged revision is kept. Ask the user whether to redo it on the current text, then publish with --expect ' + actual + ', or end the review.' };
        }
      }
    }
    if (!review) {
      const reviewId = randomUUID();
      const text = readDoc(docPath);
      review = { version: 1, reviewId, file: docPath, round: 1, startedAt: nowISO(), owner, textHash: hashText(text), snapshot: text };
      writeJSONAtomic(p.review, review);
      ensureGitignore(docPath);
      const unsubmitted = unsubmittedArchives(p);
      return unsubmitted.length ? { action: 'new', reviewId, round: 1, owner, unsubmitted } : { action: 'new', reviewId, round: 1, owner };
    }
    if (!id || id !== review.reviewId) {
      return { action: 'refused', reviewId: review.reviewId, round: review.round, owner: review.owner, code: 4,
               message: `A review of this file is active (round ${review.round}, started by ${review.owner}). Pass its id to resume, or run done to end it.` };
    }
    const comments = roundComments(readJSON(p.comments), review);
    if (comments && comments.status === 'submitted') {
      const list = commentsOfRound(comments, review.round);
      if (list.length === 0) {
        const ended = endUnderLock(p, review.reviewId, abortAfter);
        return { action: 'approved', reviewId: review.reviewId, round: review.round, ended };
      }
      return { action: 'needs-replies', reviewId: review.reviewId, round: review.round, owner: review.owner,
               comments: list, submittedTextHash: comments.submittedTextHash,
               markdown: renderComments({ comments: list, round: review.round, fileName: displayName(docPath), reviewId: review.reviewId }) };
    }
    return { action: 'resume', reviewId: review.reviewId, round: review.round, owner: review.owner };
  });
}

// Archives written by End review whose round was never submitted: comments the user wrote
// and then lost by pressing End review instead of Submit. start reports them so the
// new review can offer to restore them.
function archivePattern(p) {
  const name = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + name + '\\.comments\\.[0-9a-f-]{36}(-\\d+)?\\.json$');
}

function isArchivePath(p, file) {
  const abs = path.resolve(file);
  return path.dirname(abs) === p.folder && archivePattern(p).test(path.basename(abs)) && abs !== p.comments;
}

function unsubmittedArchives(p) {
  if (!exists(p.folder)) return [];
  const out = [];
  for (const entry of fs.readdirSync(p.folder).sort()) {
    const file = path.join(p.folder, entry);
    if (!isArchivePath(p, file)) continue;
    const a = readJSON(file);
    if (!a || a.status === 'submitted') continue;
    const list = commentsOfRound(a, a.round);
    if (!list.length) continue;
    out.push({ archive: file, reviewId: a.reviewId, round: a.round, count: list.length,
               comments: list.map(c => ({ id: c.id, heading: c.heading, line: c.line, quote: c.quote, text: c.text })) });
  }
  return out;
}

// Copies the comments of an unsubmitted archive into the active review's current round,
// as drafts with fresh ids, then removes the archive. Leaf watches the comments file
// and re-reads it; its own later writes merge with the file on disk under the lock.
export async function restore(docPath, id, archive) {
  const p = paths(docPath);
  return withLock(p, async () => {
    const review = readJSON(p.review);
    if (!review || review.reviewId !== id) return { result: 'refused', code: 4, message: 'no active review with id ' + id };
    // Only a real archive of this document: never the live comments file or any other
    // working file, which restore deletes at the end.
    if (!isArchivePath(p, archive)) return { result: 'refused', code: 4, message: 'not an archive of this document: ' + archive };
    // A publish interrupted after writing round N+1 leaves the staged file for round N.
    // start's recovery may rewind the review to N; comments advanced here would then be
    // stranded on N+1. Recover first.
    if (review.round > 1 && exists(p.staged(review.reviewId, review.round - 1))) {
      return { result: 'refused', code: 4, message: `a publish of round ${review.round - 1} was interrupted; run start ${docPath} ${id} first` };
    }
    const a = exists(archive) ? readJSON(archive) : null;
    if (!a) return { result: 'refused', code: 4, message: 'no such archive: ' + archive };
    const list = commentsOfRound(a, a.round);
    if (!list.length) return { result: 'refused', code: 4, message: 'the archive has no unsubmitted comments' };
    let comments = readJSON(p.comments);
    if (!comments || comments.reviewId !== review.reviewId) {
      comments = { version: 1, reviewId: review.reviewId, file: review.file, round: review.round, status: 'draft',
                   submittedAt: null, submittedTextHash: null, enteredRounds: [], lastCommentNumber: 0, comments: [] };
    }
    if (comments.round < review.round) {
      // Leaf has not entered the current round yet (just published, or the tab is
      // closed): move the file to it as a draft, the way Leaf's own entry does, without
      // claiming the round was entered.
      comments = { ...comments, round: review.round, status: 'draft', submittedAt: null, submittedTextHash: null };
    }
    if (comments.round !== review.round || comments.status === 'submitted') {
      return { result: 'refused', code: 4, message: `round ${review.round} is not open for comments` };
    }
    const ids = [];
    // The counter is the rule; the highest existing id is a guard against a file
    // that lacks it, so an id is never reused.
    const highest = Math.max(0, ...comments.comments.map(c => Number((/^c(\d+)$/.exec(c.id) || [])[1]) || 0));
    let n = Math.max(comments.lastCommentNumber || 0, highest);
    for (const c of list) {
      n++;
      const copy = { ...c, id: 'c' + n, round: review.round };
      comments.comments.push(copy);
      ids.push(copy.id);
    }
    comments.lastCommentNumber = n;
    writeJSONAtomic(p.comments, comments);
    fs.rmSync(archive, { force: true });
    return { result: 'restored', reviewId: review.reviewId, round: review.round, count: ids.length, ids };
  });
}

// Steps 1 to 4 of ending, caller holds the lock. Returns true when complete.
function endUnderLock(p, id, abortAfter) {
  if (exists(p.review)) {
    fs.rmSync(p.endingMarker, { force: true });
    fs.renameSync(p.review, p.endingMarker);
  } else if (!exists(p.endingMarker)) {
    // Nothing active; still clean up leftovers of this id.
    archiveComments(p, id);
    removeWorkingFiles(p, id);
    return true;
  }
  if (abortAfter === 1) return false;
  return finishEnding(p, id, abortAfter);
}

export async function done(docPath, id, { abortAfter } = {}) {
  const p = paths(docPath);
  if (!exists(p.folder)) return { result: 'nothing' };
  return withLock(p, async () => {
    const review = readJSON(p.review);
    const marker = readJSON(p.endingMarker);
    const activeId = review?.reviewId || marker?.reviewId || null;
    if (id && activeId && id !== activeId) {
      return { result: 'refused', reviewId: activeId, code: 4, message: 'another review is active: ' + activeId };
    }
    const target = id || activeId;
    if (!target) return { result: 'nothing' };
    const hadSomething = !!(review || marker || exists(p.comments) ||
      fs.readdirSync(p.folder).some(e => e.startsWith(`${p.name}.${target}.`)));
    if (!hadSomething) return { result: 'nothing' };
    const complete = endUnderLock(p, target, abortAfter);
    return complete ? { result: 'ended', reviewId: target } : { result: 'aborted', reviewId: target };
  });
}

export async function publish(docPath, id, round, { expect, abortAfter } = {}) {
  const p = paths(docPath);
  docPath = p.document;
  round = Number(round);
  if (!exists(p.folder)) return { result: 'cancelled', code: 3 };
  return withLock(p, async () => {
    const review = readJSON(p.review);
    if (!review || review.reviewId !== id) return { result: 'cancelled', code: 3 };
    if (review.round !== round) return { result: 'stale', code: 6, round: review.round };
    const staged = p.staged(id, round);
    if (!exists(staged)) return { result: 'no-revision', code: 5, staged };
    const comments = roundComments(readJSON(p.comments), review);
    if (!comments || comments.status !== 'submitted') return { result: 'incomplete', code: 7, message: 'round ' + round + ' is not submitted' };
    const replies = readJSON(p.replies(id, round));
    const list = commentsOfRound(comments, round);
    const answered = new Set((replies?.replies || []).map(r => r.commentId));
    const missing = list.map(c => c.id).filter(cid => !answered.has(cid));
    if (!replies || missing.length) return { result: 'incomplete', code: 7, missing, replies: p.replies(id, round) };
    const expected = expect || comments.submittedTextHash;
    const actual = hashFile(docPath);
    if (expected !== actual) return { result: 'changed', code: 8, expected, actual };
    const text = readDoc(staged);
    const next = {
      version: 1, reviewId: id, file: docPath, round: round + 1, startedAt: review.startedAt, owner: review.owner,
      textHash: hashText(text), snapshot: text, previousTextHash: review.textHash, previousSnapshot: review.snapshot,
      replies: replies.replies,
      // The document hash publish verified; start checks it before finishing an interrupted move.
      baseTextHash: actual,
      // Round N's own record, so an interrupted publish can be undone without loss.
      priorRound: { previousTextHash: review.previousTextHash, previousSnapshot: review.previousSnapshot, replies: review.replies,
                    baseTextHash: review.baseTextHash, priorRound: review.priorRound },
    };
    for (const k of Object.keys(next.priorRound)) if (next.priorRound[k] === undefined) delete next.priorRound[k];
    writeJSONAtomic(p.review, next);
    if (abortAfter === 1) return { result: 'aborted', round: round + 1 };
    const complete = finishPublish(p, docPath, id, round, abortAfter, true);
    return complete ? { result: 'published', round: round + 1 } : { result: 'aborted', round: round + 1 };
  });
}

export async function wait(docPath, id, round, { timeoutMs = 4 * 60 * 60 * 1000, intervalMs = 1000 } = {}) {
  const p = paths(docPath);
  round = Number(round);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const review = readJSON(p.review);
    if (!review || review.reviewId !== id) return { code: 3, status: 'cancelled' };
    const comments = roundComments(readJSON(p.comments), review);
    if (comments && comments.status === 'submitted' && review.round === round) {
      const list = commentsOfRound(comments, round);
      return { code: 0, status: 'submitted', count: list.length, submittedTextHash: comments.submittedTextHash, comments: list,
               markdown: renderComments({ comments: list, round, fileName: displayName(p.document), reviewId: id }) };
    }
    if (Date.now() >= deadline) return { code: 2, status: 'timeout' };
    await sleep(intervalMs);
  }
}

// CLI entry: prints one JSON line, returns the exit code.
export async function run(cmd, positional, flags) {
  const [docPath, a, b] = positional;
  if (!docPath) throw new Error('missing <path>');
  let result;
  const abortAfter = flags['abort-after'] ? Number(flags['abort-after']) : undefined;
  switch (cmd) {
    case 'start': result = await start(docPath, a, { owner: flags.owner || 'claude', abortAfter }); break;
    case 'wait': result = await wait(docPath, a, b, { timeoutMs: flags['timeout-ms'] ? Number(flags['timeout-ms']) : undefined, intervalMs: flags['interval-ms'] ? Number(flags['interval-ms']) : undefined }); break;
    case 'publish': result = await publish(docPath, a, b, { expect: flags.expect, abortAfter }); break;
    case 'done': result = await done(docPath, a, { abortAfter }); break;
    case 'restore': result = await restore(docPath, a, b); break;
    default: throw new Error('unknown command ' + cmd);
  }
  const code = result.code || 0;
  const { code: _c, ...rest } = result;
  console.log(JSON.stringify(rest));
  return code;
}
