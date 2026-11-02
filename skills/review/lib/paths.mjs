// Where a document's review files live: .leaf beside it, names prefixed with the
// document's full file name. Mirrors Leaf's ReviewPaths.
import path from 'node:path';

export function paths(docPath) {
  const abs = path.resolve(docPath);
  const folder = path.join(path.dirname(abs), '.leaf');
  const name = path.basename(abs);
  const f = (s) => path.join(folder, name + s);
  return {
    document: abs,
    folder,
    name,
    review: f('.review.json'),
    comments: f('.comments.json'),
    lock: f('.lock'),
    endingMarker: f('.review.ending.json'),
    staged: (id, round) => f(`.${id}.r${round}.revision.md`),
    replies: (id, round) => f(`.${id}.r${round}.replies.json`),
    backup: (round) => f(`.backup.${round}.md`),
    archive: (id, attempt) => f(`.comments.${id}${attempt === 0 ? '' : '-' + (attempt + 1)}.json`),
  };
}
