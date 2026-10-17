// Export a doc to another format: a one-way copy of the doc as saved on disk,
// with the comment threads the user picks. The doc and its sidecar are only
// read. PDF is the HTML page printed by a browser engine (for the CLI, an
// installed Chrome or Edge: src/export/browser.js).

import { basename } from 'node:path';
import { refreshSidecar } from '../core/anchor.js';
import { readDoc, readSidecar } from '../store/files.js';
import { COMMENT_CHOICES, pickThreads } from './comments.js';
import { renderHtml } from './html.js';

export { COMMENT_CHOICES } from './comments.js';

export const FORMATS = Object.freeze({
  pdf: { extension: 'pdf', type: 'application/pdf', label: 'PDF' },
  html: { extension: 'html', type: 'text/html; charset=utf-8', label: 'Web page' },
});
export const PAPERS = Object.freeze(['a4', 'letter']);

// Regions that use US Letter paper; everywhere else uses A4.
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV', 'NI', 'BZ']);

export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

/** The paper size people use in `locale` (e.g. 'en-US' → 'letter'). */
export function defaultPaper(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  let region = null;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    // an odd locale: A4
  }
  return LETTER_REGIONS.has(region) ? 'letter' : 'a4';
}

/** "plan.md" → "plan.pdf". */
export function exportName(docName, format) {
  return docName.replace(/\.(md|markdown)$/i, '') + '.' + FORMATS[format].extension;
}

/** Throws an ExportError unless the options are known; returns them complete. */
export function checkExportOptions({ format, comments = 'none', paper, font = 'sans' } = {}) {
  if (!Object.hasOwn(FORMATS, format)) throw new ExportError('format must be pdf or html');
  if (!COMMENT_CHOICES.includes(comments)) throw new ExportError('comments must be none, open or all');
  if (paper !== undefined && paper !== null && !PAPERS.includes(paper)) throw new ExportError('paper must be a4 or letter');
  if (!['sans', 'serif', 'mono'].includes(font)) throw new ExportError('font must be sans, serif or mono');
  return { format, comments, paper: paper ?? defaultPaper(), font };
}

/**
 * The doc at `docPath` in `format`: { bytes, type, name }. For 'pdf' the bytes
 * are the HTML page to print (`type` text/html), ready for a browser engine.
 */
export async function exportDoc(docPath, options) {
  const { format, comments, paper, font } = checkExportOptions(options);
  const { markdown, hash } = await readDoc(docPath);
  const stored = await readSidecar(docPath);
  const sidecar = stored.threads.length > 0 ? refreshSidecar(stored, markdown, hash) : stored;
  const name = basename(docPath);
  const input = { name, markdown, docPath, picked: pickThreads(sidecar, markdown, comments), font, paper };
  const html = Buffer.from(await renderHtml(input), 'utf8');
  return { bytes: html, type: FORMATS.html.type, name: exportName(name, format) };
}
