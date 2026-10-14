// 1-based source line of each attached thread's quote, for humans and agents.

import { lineOf, project, sourceRange } from './project.js';

/** @returns {(number | null)[]} one entry per thread; null when doc-level or detached */
export function threadLines(markdown, threads) {
  if (!threads.some((t) => t.anchor && !t.detached)) return threads.map(() => null);
  const projection = project(markdown);
  return threads.map((t) => {
    if (!t.anchor || t.detached) return null;
    const end = Math.min(t.anchor.start + t.anchor.exact.length, projection.text.length);
    if (t.anchor.start >= end) return null;
    return lineOf(markdown, sourceRange(projection, t.anchor.start, end).start);
  });
}
