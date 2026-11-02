// The markdown rendering of a round's comments, identical to Leaf's CommentsMarkdown
// (both pinned to fixtures/review/comments-example.md).

function label(c) {
  if (c.kind === 'general') return 'Whole document';
  const parts = [];
  if (c.heading) parts.push(c.heading);
  if (c.line !== null && c.line !== undefined) parts.push('line ' + c.line);
  const anchor = c.kind === 'point'
    ? 'at "…' + (c.prefix || '').slice(-20) + '"'
    : 'on "' + (c.quote || '') + '"';
  if (parts.length === 0) return anchor[0].toUpperCase() + anchor.slice(1);
  return parts.concat([anchor]).join(', ');
}

export function renderComments({ comments, round, fileName, reviewId }) {
  const count = comments.length === 1 ? '1 comment' : comments.length + ' comments';
  const id = reviewId ? 'review ' + reviewId + ', ' : '';
  let out = `## Review round ${round} of ${fileName} (${id}${count})\n\n`;
  comments.forEach((c, i) => {
    out += `${i + 1}. [${c.id}] ${label(c)}:\n`;
    for (const line of c.text.split('\n')) out += '   ' + line + '\n';
  });
  return out;
}
