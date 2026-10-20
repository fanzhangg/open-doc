// How a text is indented, worked out from the text itself.

const SAMPLE_LINES = 2000;

/**
 * The indent `text` uses: `{ tabs: true }`, or `{ tabs: false, size }` for the
 * most common step in the width of spaces between one indented line and the
 * next (2 to 8); null when nothing is indented. Looks at the first lines only.
 */
export function detectIndent(text) {
  let tabLed = 0;
  let spaceLed = 0;
  let previous = 0;
  const steps = new Map();
  for (const line of text.split('\n', SAMPLE_LINES)) {
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.startsWith('\t')) tabLed++;
    else if (lead !== '') spaceLed++;
    const step = Math.abs(lead.length - previous);
    if (step >= 2 && step <= 8 && !lead.includes('\t')) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = lead.includes('\t') ? 0 : lead.length;
  }
  if (tabLed > spaceLed) return { tabs: true };
  const [size] = [...steps].sort(([a, countA], [b, countB]) => countB - countA || a - b)[0] ?? [];
  return size ? { tabs: false, size } : null;
}
