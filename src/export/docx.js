// The doc as a Word file, built from its syntax tree so it stays editable in
// Word: real headings, lists, tables, links and footnotes, pictures from the
// doc's folder, and each picked comment thread as a Word comment on its text,
// replies threaded under it and resolved threads marked done.

import {
  AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, Document, ExternalHyperlink,
  FootnoteReferenceRun, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx';
import { parseMarkdown } from '../core/project.js';
import { markThreads } from './comments.js';
import { readLocalImage } from './images.js';
import { clip, titleOf } from './html.js';

const FONTS = { sans: 'Calibri', serif: 'Cambria', mono: 'Consolas' };
const MONO = 'Consolas';
const PAGE = { a4: { width: 11906, height: 16838 }, letter: { width: 12240, height: 15840 } }; // twips
const MARGIN = 1440;
const MAX_IMAGE_WIDTH = 600; // px, about the text width
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const HEADING_SIZES = [40, 32, 28, 24, 22, 22]; // half-points
const QUOTE_BORDER = { left: { style: BorderStyle.SINGLE, size: 12, color: 'D9D8D4', space: 8 } };
const RULE = { style: BorderStyle.SINGLE, size: 4, color: 'D9D8D4' };

/**
 * @param {{ name: string, markdown: string, docPath: string, picked: ReturnType<typeof import('./comments.js').pickThreads>,
 *           font?: 'sans' | 'serif' | 'mono', paper?: 'a4' | 'letter' }} options
 * @returns {Promise<Buffer>}
 */
export async function renderDocx({ name, markdown, docPath, picked, font = 'sans', paper = 'a4' }) {
  const tree = parseMarkdown(markdown);
  const marked = markThreads(tree, markdown, picked);
  const ctx = {
    definitions: new Map(),
    images: new Map(),
    footnoteIds: new Map(),
    footnotes: {},
    orderedLists: 0,
    commentIds: new Map(), // thread number → Word comment ids, one per message
    started: new Set(),
  };
  let nextId = 0;
  for (const p of picked) ctx.commentIds.set(p.n, p.thread.messages.map(() => nextId++));

  walk(tree, (node) => {
    if (node.type === 'definition') ctx.definitions.set(node.identifier, node);
    if (node.type === 'footnoteDefinition' && !ctx.footnoteIds.has(node.identifier)) ctx.footnoteIds.set(node.identifier, ctx.footnoteIds.size + 1);
  });
  await loadImages(tree, docPath, ctx);
  walk(tree, (node) => {
    if (node.type === 'footnoteDefinition') ctx.footnotes[ctx.footnoteIds.get(node.identifier)] = { children: blocks(node.children, ctx, {}) };
  });

  const children = blocks(tree.children, ctx, {});
  // Threads whose text is not in the doc (gone, on a code block, or on the
  // whole doc) are attached to a line each at the end.
  const loose = picked.filter((p) => !marked.has(p.n));
  if (loose.length > 0) {
    children.push(new Paragraph({ spacing: { before: 480 }, children: [new TextRun({ text: 'Other comments', bold: true })] }));
    for (const p of loose) {
      const label = p.thread.anchor ? `“${clip(p.thread.anchor.exact, 140)}”` : 'On the whole doc';
      children.push(new Paragraph({ children: inlineChildren([
        { kind: 'start', n: p.n }, { kind: 'run', text: label, style: { italics: true } }, { kind: 'end', n: p.n },
      ], ctx) }));
    }
  }
  if (children.length === 0) children.push(new Paragraph({}));

  const docFont = FONTS[font] ?? FONTS.sans;
  const doc = new Document({
    creator: 'OpenDoc',
    title: titleOf(tree) ?? name.replace(/\.(md|markdown)$/i, ''),
    styles: {
      default: { document: { run: { font: docFont, size: font === 'mono' ? 20 : 22 }, paragraph: { spacing: { after: 160, line: 288 } } } },
      paragraphStyles: HEADINGS.map((_, i) => ({
        id: `Heading${i + 1}`,
        name: `Heading ${i + 1}`,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: docFont, size: HEADING_SIZES[i], bold: true, color: '2F2E2B' },
        paragraph: { spacing: { before: i === 0 ? 360 : 280, after: 120 }, keepNext: true, keepLines: true },
      })),
    },
    numbering: { config: [listConfig('od-bullets', false), listConfig('od-numbers', true)] },
    footnotes: ctx.footnotes,
    comments: { children: picked.flatMap((p) => wordComments(p, ctx)) },
    sections: [{
      properties: { page: { size: PAGE[paper] ?? PAGE.a4, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

function wordComments({ n, thread }, ctx) {
  const ids = ctx.commentIds.get(n);
  const resolved = thread.status === 'resolved';
  return thread.messages.map((m, i) => ({
    id: ids[i],
    author: m.author.kind === 'agent' ? `${m.author.name} (agent)` : m.author.name,
    initials: m.author.name.slice(0, 2).toUpperCase(),
    date: new Date(m.createdAt),
    ...(i > 0 ? { parentId: ids[0] } : {}),
    ...(resolved ? { resolved: true } : {}),
    children: m.body.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
  }));
}

// ---- blocks ----

/** `opts`: { quote: depth, list: { reference, level, instance }, header: bool } */
function blocks(nodes, ctx, opts) {
  const out = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(paragraph(inline(node.children, ctx), ctx, opts));
        break;
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[node.depth - 1], children: inlineChildren(inline(node.children, ctx), ctx) }));
        break;
      case 'blockquote':
        out.push(...blocks(node.children, ctx, { ...opts, quote: (opts.quote ?? 0) + 1 }));
        break;
      case 'list':
        out.push(...list(node, ctx, opts));
        break;
      case 'code':
      case 'html': {
        const lines = node.value.split('\n');
        const runs = lines.map((line, i) => new TextRun({ text: line, font: MONO, size: 19, ...(i > 0 ? { break: 1 } : {}) }));
        out.push(new Paragraph({
          children: runs,
          shading: { type: ShadingType.CLEAR, fill: 'F6F6F4', color: 'auto' },
          spacing: { before: 60, after: 200, line: 252 },
          ...indentFor(opts),
        }));
        break;
      }
      case 'thematicBreak':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9D8D4', space: 1 } }, spacing: { after: 240 } }));
        break;
      case 'table':
        out.push(table(node, ctx), new Paragraph({ spacing: { after: 0 } }));
        break;
      default:
        // definitions and footnote definitions are used where they are referenced
        break;
    }
  }
  return out;
}

function paragraph(items, ctx, opts) {
  const numbered = opts.list && !opts.continued && !opts.task;
  return new Paragraph({
    children: inlineChildren(items, ctx),
    ...(numbered ? { numbering: { reference: opts.list.reference, level: opts.list.level, ...(opts.list.instance ? { instance: opts.list.instance } : {}) } } : {}),
    ...(numbered && opts.quote ? { border: QUOTE_BORDER } : {}),
    ...(numbered ? {} : indentFor(opts)),
    ...(opts.list ? { spacing: { after: 60 } } : opts.quote ? { spacing: { before: 120, after: 120 } } : {}),
  });
}

function list(node, ctx, opts) {
  const level = opts.list ? opts.list.level + 1 : 0;
  const reference = node.ordered ? 'od-numbers' : 'od-bullets';
  const instance = node.ordered ? ++ctx.orderedLists : 0;
  const out = [];
  for (const item of node.children) {
    // A task item shows its box instead of a bullet.
    const own = { ...opts, list: { reference, level, instance }, task: typeof item.checked === 'boolean' };
    const children = item.children.length > 0 ? item.children : [{ type: 'paragraph', children: [] }];
    children.forEach((child, i) => {
      if (child.type === 'paragraph') {
        const items = inline(child.children, ctx);
        if (i === 0 && own.task) items.unshift({ kind: 'run', text: item.checked ? '☒ ' : '☐ ', style: {} });
        out.push(paragraph(items, ctx, i === 0 ? own : { ...own, continued: true }));
      } else if (child.type === 'list') {
        out.push(...list(child, ctx, { ...own, task: false }));
      } else {
        if (i === 0 && !own.task) out.push(paragraph([], ctx, own));
        out.push(...blocks([child], ctx, { ...own, continued: true }));
      }
    });
  }
  return out;
}

function table(node, ctx) {
  const columns = Math.max(...node.children.map((row) => row.children.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: RULE, bottom: RULE, left: RULE, right: RULE, insideHorizontal: RULE, insideVertical: RULE },
    rows: node.children.map((row, r) => new TableRow({
      tableHeader: r === 0,
      children: Array.from({ length: columns }, (_, c) => {
        const cell = row.children[c];
        const items = cell ? inline(cell.children, ctx) : [];
        if (r === 0) for (const item of items) if (item.style) item.style = { ...item.style, bold: true };
        return new TableCell({
          children: [new Paragraph({ alignment: alignFor(node.align?.[c]), spacing: { after: 0 }, children: inlineChildren(items, ctx) })],
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          ...(r === 0 ? { shading: { type: ShadingType.CLEAR, fill: 'F6F6F4', color: 'auto' } } : {}),
        });
      }),
    })),
  });
}

const alignFor = (align) => ({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT }[align] ?? AlignmentType.LEFT);

function indentFor(opts) {
  const quote = opts.quote ?? 0;
  const list = opts.list ? 360 * (opts.list.level + 1) : 0;
  const left = quote * 440 + list;
  return {
    ...(left > 0 ? { indent: { left } } : {}),
    ...(quote > 0 ? { border: QUOTE_BORDER } : {}),
  };
}

function listConfig(reference, ordered) {
  const bullets = ['•', '◦', '▪'];
  const formats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  return {
    reference,
    levels: Array.from({ length: 9 }, (_, level) => ({
      level,
      format: ordered ? formats[level % 3] : LevelFormat.BULLET,
      text: ordered ? `%${level + 1}.` : bullets[level % 3],
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 360 } } },
    })),
  };
}

// ---- inline ----

// Inline content as a flat list of items, so comment ranges can start and
// end anywhere, links included:
//   { kind: 'run', text, style } { kind: 'break' } { kind: 'image', image, alt, style }
//   { kind: 'footnote', id } { kind: 'start', n } { kind: 'end', n }
function inline(nodes, ctx, style = {}) {
  const out = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ kind: 'run', text: node.value.replace(/\s*\n\s*/g, ' '), style });
        break;
      case 'inlineCode':
        out.push({ kind: 'run', text: node.value, style: { ...style, code: true } });
        break;
      case 'html':
        out.push({ kind: 'run', text: node.value, style });
        break;
      case 'break':
        out.push({ kind: 'break' });
        break;
      case 'emphasis':
        out.push(...inline(node.children, ctx, { ...style, italics: true }));
        break;
      case 'strong':
        out.push(...inline(node.children, ctx, { ...style, bold: true }));
        break;
      case 'delete':
        out.push(...inline(node.children, ctx, { ...style, strike: true }));
        break;
      case 'link':
        out.push(...inline(node.children, ctx, { ...style, link: node.url }));
        break;
      case 'linkReference': {
        const url = ctx.definitions.get(node.identifier)?.url;
        out.push(...inline(node.children, ctx, url ? { ...style, link: url } : style));
        break;
      }
      case 'image':
      case 'imageReference': {
        const url = node.type === 'image' ? node.url : ctx.definitions.get(node.identifier)?.url;
        const image = ctx.images.get(url);
        if (image) out.push({ kind: 'image', image, alt: node.alt ?? '', style });
        else out.push({ kind: 'run', text: node.alt ? `[${node.alt}]` : '[image]', style: url ? { ...style, link: url } : style });
        break;
      }
      case 'footnoteReference': {
        const id = ctx.footnoteIds.get(node.identifier);
        if (id) out.push({ kind: 'footnote', id });
        break;
      }
      case 'odMark':
        for (const n of node.threads) {
          if (!ctx.started.has(n)) {
            ctx.started.add(n);
            out.push({ kind: 'start', n });
          }
        }
        out.push(...inline(node.children, ctx, style));
        break;
      case 'odRef':
        out.push({ kind: 'end', n: node.n });
        break;
      default:
        if (node.children) out.push(...inline(node.children, ctx, style));
    }
  }
  return out;
}

/** Items → paragraph children, runs of the same link grouped into one hyperlink. */
function inlineChildren(items, ctx) {
  const out = [];
  let group = null; // { link, children }
  const flush = () => {
    if (group) out.push(new ExternalHyperlink({ link: group.link, children: group.children }));
    group = null;
  };
  for (const item of items) {
    if (item.kind === 'start' || item.kind === 'end') {
      flush();
      const ids = ctx.commentIds.get(item.n) ?? [];
      if (item.kind === 'start') out.push(...ids.map((id) => new CommentRangeStart(id)));
      else {
        out.push(...ids.map((id) => new CommentRangeEnd(id)));
        out.push(...ids.map((id) => new TextRun({ children: [new CommentReference(id)] })));
      }
      continue;
    }
    const child = toRun(item);
    const link = item.style?.link;
    if (link) {
      if (group?.link !== link) {
        flush();
        group = { link, children: [] };
      }
      group.children.push(child);
    } else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

function toRun(item) {
  if (item.kind === 'break') return new TextRun({ break: 1 });
  if (item.kind === 'footnote') return new FootnoteReferenceRun(item.id);
  if (item.kind === 'image') {
    const { image } = item;
    const scale = Math.min(1, MAX_IMAGE_WIDTH / image.width);
    return new ImageRun({
      type: IMAGE_TYPES[image.type],
      data: image.data,
      transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
      altText: { name: item.alt || 'image', description: item.alt, title: item.alt },
    });
  }
  const { bold, italics, strike, code, link } = item.style;
  return new TextRun({
    text: item.text,
    ...(bold ? { bold } : {}),
    ...(italics ? { italics } : {}),
    ...(strike ? { strike } : {}),
    ...(code ? { font: MONO, size: 19, shading: { type: ShadingType.CLEAR, fill: 'F1F1EF', color: 'auto' } } : {}),
    ...(link ? { style: 'Hyperlink' } : {}),
  });
}

// ---- helpers ----

async function loadImages(tree, docPath, ctx) {
  const urls = new Set();
  walk(tree, (node) => {
    if (node.type === 'image') urls.add(node.url);
    if (node.type === 'imageReference') urls.add(ctx.definitions.get(node.identifier)?.url);
  });
  await Promise.all([...urls].map(async (url) => {
    const image = await readLocalImage(docPath, url);
    // Word takes PNG, JPEG and GIF pictures whose size is known.
    if (image && IMAGE_TYPES[image.type] && image.width > 0 && image.height > 0) ctx.images.set(url, image);
  }));
}

function walk(node, fn) {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

