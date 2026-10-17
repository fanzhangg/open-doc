// The doc as one self-contained HTML page: the reading view of the editor
// (always light), pictures from the doc's folder inlined, and the picked
// comment threads in a column beside the text (below it when printed). PDF
// exports print this same page.

import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import { parseMarkdown } from '../core/project.js';
import { markThreads } from './comments.js';
import { dataUri, readLocalImage } from './images.js';

const FONTS = {
  sans: { family: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif', size: '16px', leading: 1.7 },
  serif: { family: 'Charter, "Bitstream Charter", "Iowan Old Style", "Sitka Text", Cambria, Georgia, "Songti SC", SimSun, serif', size: '17px', leading: 1.65 },
  mono: { family: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace', size: '15px', leading: 1.65 },
};
const PAPER = { a4: 'A4', letter: 'letter' };

/**
 * @param {{ name: string, markdown: string, docPath: string, picked: ReturnType<typeof import('./comments.js').pickThreads>,
 *           font?: 'sans' | 'serif' | 'mono', paper?: 'a4' | 'letter' }} options
 * @returns {Promise<string>}
 */
export async function renderHtml({ name, markdown, docPath, picked, font = 'sans', paper = 'a4' }) {
  const tree = parseMarkdown(markdown);
  const marked = markThreads(tree, markdown, picked, { outsideLinks: true });
  await inlineImages(tree, docPath);
  const body = toHast(tree, {
    allowDangerousHtml: true,
    handlers: {
      odMark: (state, node) => ({
        type: 'element', tagName: 'mark', properties: { className: ['od-mark'], dataComments: node.threads.join(' ') }, children: state.all(node),
      }),
      odRef: (_state, node) => h('sup', { className: ['od-ref'] }, [h('a', { href: `#comment-${node.n}`, id: `ref-${node.n}` }, [String(node.n)])]),
    },
  });
  const article = h('article', { className: ['od-doc'] }, body.type === 'root' ? body.children : [body]);
  const main = picked.length > 0
    ? h('div', { className: ['od-export', 'od-with-comments'] }, [article, commentsColumn(picked, marked)])
    : h('div', { className: ['od-export'] }, [article]);
  const fonts = FONTS[font] ?? FONTS.sans;
  const css = STYLE
    .replace('$FONT', fonts.family).replace('$SIZE', fonts.size).replace('$LEADING', String(fonts.leading))
    .replace('$PAPER', PAPER[paper] ?? PAPER.a4);
  return '<!doctype html>\n' + toHtml({
    type: 'root',
    children: [h('html', { lang: 'en' }, [
      h('head', {}, [
        h('meta', { charSet: 'utf-8' }),
        // A document, not an app: scripts in the doc's raw HTML never run.
        h('meta', { httpEquiv: 'Content-Security-Policy', content: "script-src 'none'; object-src 'none'" }),
        h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        h('meta', { name: 'generator', content: 'OpenDoc' }),
        h('title', {}, [titleOf(tree) ?? name.replace(/\.(md|markdown)$/i, '')]),
        { type: 'element', tagName: 'style', properties: {}, children: [{ type: 'raw', value: css }] },
      ]),
      h('body', {}, [main]),
    ])],
  }, { allowDangerousHtml: true });
}

function commentsColumn(picked, marked) {
  return h('aside', { className: ['od-comments'], ariaLabel: 'Comments' }, [
    h('h2', {}, ['Comments']),
    ...picked.map(({ n, thread, range }) => {
      const resolved = thread.status === 'resolved';
      const head = [
        marked.has(n) ? h('a', { className: ['od-n'], href: `#ref-${n}` }, [String(n)]) : h('span', { className: ['od-n'] }, [String(n)]),
        thread.anchor ? h('q', {}, [clip(thread.anchor.exact, 140)]) : h('span', { className: ['od-quote-none'] }, ['On the whole doc']),
        ...(resolved ? [h('span', { className: ['od-tag'] }, ['Resolved'])] : []),
        ...(thread.anchor && !range ? [h('span', { className: ['od-tag'] }, ['Text no longer in the doc'])] : []),
      ];
      return h('section', { className: ['od-comment', ...(resolved ? ['od-resolved'] : [])], id: `comment-${n}` }, [
        h('div', { className: ['od-comment-head'] }, head),
        ...thread.messages.map((m) => h('div', { className: ['od-message'] }, [
          h('div', { className: ['od-author'] }, [
            m.author.name,
            ...(m.author.kind === 'agent' ? [h('span', { className: ['od-agent'] }, ['agent'])] : []),
            h('time', { dateTime: m.createdAt }, [formatDate(m.createdAt)]),
          ]),
          h('div', { className: ['od-body'] }, [m.body]),
        ])),
      ]);
    }),
  ]);
}

async function inlineImages(tree, docPath) {
  const jobs = [];
  const walk = (node) => {
    if (node.type === 'image' || node.type === 'definition') {
      jobs.push(readLocalImage(docPath, node.url).then((image) => {
        if (image) node.url = dataUri(image);
      }));
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  await Promise.all(jobs);
}

/** The text of the doc's first top-level heading, when it starts with one. */
export function titleOf(tree) {
  const first = tree.children.find((node) => node.type !== 'html' && node.type !== 'definition');
  if (first?.type !== 'heading' || first.depth !== 1) return null;
  const text = plainText(first).trim();
  return text || null;
}

export function plainText(node) {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(plainText).join('');
}

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

function h(tagName, properties, children = []) {
  return {
    type: 'element',
    tagName,
    properties,
    children: children.map((c) => (typeof c === 'string' ? { type: 'text', value: c } : c)),
  };
}

const STYLE = `
@page { size: $PAPER; margin: 20mm 18mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #2f2e2b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.od-export { max-width: 46rem; margin: 0 auto; padding: 4rem 1.5rem; }
.od-export.od-with-comments { max-width: 74rem; display: grid; grid-template-columns: minmax(0, 46rem) minmax(0, 22rem); gap: 3.5rem; justify-content: center; }
.od-doc { font-family: $FONT; font-size: $SIZE; line-height: $LEADING; overflow-wrap: break-word; }
.od-doc > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; font-weight: 650; margin: 1.6em 0 0.5em; break-after: avoid; }
h1 { font-size: 2em; margin-top: 0.8em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4, h5, h6 { font-size: 1em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.6em; } li > p { margin: 0 0 0.25em; } li { margin: 0.15em 0; }
li:has(> input[type="checkbox"]) { list-style: none; } li > input[type="checkbox"] { margin: 0 0.5em 0 -1.4em; }
a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
blockquote { border-left: 3px solid #d9d8d4; padding-left: 1em; color: #5f5e5a; }
code, pre { font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace; }
code { font-size: 0.85em; background: #f1f1ef; padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: #f6f6f4; padding: 0.9em 1.1em; border-radius: 6px; overflow-x: auto; line-height: 1.5; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 0.85em; }
hr { border: 0; border-top: 1px solid #e3e2de; margin: 2em 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; break-inside: avoid; }
th, td { border: 1px solid #e3e2de; padding: 0.45em 0.7em; text-align: left; vertical-align: top; }
th { background: #f6f6f4; font-weight: 600; }
.footnotes { font-size: 0.9em; color: #5f5e5a; border-top: 1px solid #e3e2de; margin-top: 2.5em; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
mark.od-mark { background: #fdeeb4; color: inherit; border-radius: 2px; }
sup.od-ref { line-height: 0; margin-left: 1px; }
sup.od-ref + sup.od-ref::before { content: ","; color: #9a6700; font-size: 0.75em; }
sup.od-ref a { color: #9a6700; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 0.75em; font-weight: 600; text-decoration: none; }
.od-comments { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13.5px; line-height: 1.5; }
.od-comments h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #787774; margin: 0.4em 0 1em; }
.od-comment { border: 1px solid #e3e2de; border-radius: 8px; padding: 0.8em 1em; margin-bottom: 0.8em; break-inside: avoid; }
.od-comment:target { border-color: #e0b400; }
.od-resolved { color: #5f5e5a; }
.od-comment-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5em; margin-bottom: 0.4em; }
.od-n { font-weight: 600; color: #9a6700; text-decoration: none; }
.od-comment-head q { color: #5f5e5a; font-style: italic; flex: 1 1 10em; }
.od-quote-none { color: #787774; flex: 1 1 10em; }
.od-tag { font-size: 11.5px; color: #5f5e5a; background: #f1f1ef; border-radius: 4px; padding: 0 0.4em; }
.od-message + .od-message { border-top: 1px solid #efeeeb; margin-top: 0.6em; padding-top: 0.6em; }
.od-author { font-weight: 600; display: flex; align-items: baseline; gap: 0.5em; }
.od-agent { font-weight: 500; font-size: 11px; color: #6d28d9; background: #f3efff; border-radius: 4px; padding: 0 0.35em; }
.od-author time { font-weight: 400; color: #787774; font-size: 12px; }
.od-body { white-space: pre-wrap; overflow-wrap: break-word; }
@media (max-width: 980px) {
  .od-export.od-with-comments { display: block; max-width: 46rem; }
  .od-comments { margin-top: 3rem; border-top: 1px solid #e3e2de; padding-top: 1.5rem; }
}
@media print {
  .od-export, .od-export.od-with-comments { display: block; max-width: none; padding: 0; margin: 0; }
  .od-comments { margin-top: 2.5rem; border-top: 1px solid #e3e2de; padding-top: 1.2rem; }
  a { color: inherit; }
  pre { overflow: visible; }
}
`;
