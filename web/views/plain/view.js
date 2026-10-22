// The plain view: a text file as it is, in CodeMirror, with no formatting,
// for any text file no other view claims (index.js). The doc's text is the editor's,
// so offsets on it are positions in the editor and marks are decorations
// as given. Others' edits go in as the operations that made them, outside
// the human's undo history; a buddy's is flagged with its name, any other
// also glows (as in the Markdown view).

import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, lineNumbers } from '@codemirror/view';
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { history, historyKeymap, redo, standardKeymap, undo } from '@codemirror/commands';
import { diffOps } from '../../../src/core/ot.js';
import { buddyColor } from '../../faces.js';
import { cursorNode } from '../../marks.js';
import { hydrateIcons } from '../../icons.js';
import { indentKeys, resolveIndent } from './indent.js';
import { createStatusBar } from './status.js';
import { createFind, matches } from '../../find.js';
import { indentGuides, whitespaceMarks } from './whitespace.js';

const FLASH_MS = 6000;
const CHANGE_MS = 200; // onChange waits for a pause in typing this long, as the Markdown view's does; onEdit does not
const fromDisk = Annotation.define();
const setMarks = StateEffect.define();
const addFlash = StateEffect.define();
const dropFlash = StateEffect.define();
const setFound = StateEffect.define();

// The page's marks, replaced wholesale, mapped through edits until then.
const marksField = StateField.define({
  create: () => Decoration.none,
  update: (set, tr) => tr.effects.reduce((next, effect) => (effect.is(setMarks) ? effect.value : next), set.map(tr.changes)),
  provide: (field) => EditorView.decorations.from(field),
});

// The find bar's matches, replaced wholesale, mapped through edits until then.
const foundField = StateField.define({
  create: () => Decoration.none,
  update: (set, tr) => tr.effects.reduce((next, effect) => (effect.is(setFound) ? effect.value : next), set.map(tr.changes)),
  provide: (field) => EditorView.decorations.from(field),
});

// A line holding right-to-left letters (Hebrew, Arabic…) runs the way its
// text starts (dir="auto"), and the caret moves in it as it reads.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const rtlLine = Decoration.line({ attributes: { dir: 'auto' } });
const bidi = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = linesRtl(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = linesRtl(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });

function linesRtl(view) {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (RTL.test(line.text)) ranges.push(rtlLine.range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges);
}

// Who changed what on disk, for a while.
const flashField = StateField.define({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addFlash)) next = next.update({ add: effect.value, sort: true });
      if (effect.is(dropFlash)) next = next.update({ filter: (_from, _to, decoration) => decoration.spec.flashId !== effect.value });
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The same options and interface as the Markdown view (createMarkdownView in
 * web/views/markdown/view.js). It has no tools, so `toolbar` is not used; given
 * `onComment`, a bubble over a selection offers Comment. `settings` are the
 * view's (web/views/plain/index.js), changed through `saveSettings`; an editable
 * view also has a status bar.
 *
 * @param {{ stage: HTMLElement, text: string, name: string, settings: object, saveSettings?: (patch: object) => void, editable?: boolean, color?: boolean, onChange?: () => void, onEdit?: () => void,
 *           onMarkClick?: (id: string) => void, onLayout?: () => void, onComment?: () => void }} options
 */
export async function createPlainView({ stage, text, name, settings, saveSettings = () => {}, editable = true, color = true, onChange = () => {}, onEdit = () => {}, onMarkClick = () => {}, onLayout = () => {}, onComment = null }) {
  const host = stage.querySelector('.pj-editor');
  stage.dataset.plain = ''; // the page runs edge to edge (app.css)
  let changeTimer = 0;
  let finder = null; // the find bar (web/find.js)
  let found = []; // [from, to) of each of its matches, in `foundIn`
  let foundIn = null; // the doc they were found in, while it has a query
  let query = '';
  let refind = 0;
  let composed = false; // typed in a composition not ended yet
  let bubble = null;
  let destroyed = false;
  let status = null;
  // The settings that change what CodeMirror does; the font size is a CSS variable.
  const numbers = new Compartment();
  const wrapping = new Compartment();
  const numbersFor = (own) => (own.lineNumbers ? lineNumbers() : []);
  const wrapFor = (own) => (own.wrap ? EditorView.lineWrapping : []);
  const syntax = new Compartment();
  const marking = new Compartment();
  const guiding = new Compartment();
  const markingFor = (own) => (own.whitespace === 'off' ? [] : whitespaceMarks(own.whitespace));
  const guidingFor = (own) => (own.guides ? indentGuides : []);
  const shown = (own) => [
    numbers.reconfigure(numbersFor(own)), wrapping.reconfigure(wrapFor(own)),
    marking.reconfigure(markingFor(own)), guiding.reconfigure(guidingFor(own)),
  ];
  // The indent Tab types, from the file or the settings; seen again when the settings or the file change.
  let own = settings;
  let indent;
  const reindent = (current) => {
    indent = resolveIndent(own, current);
    host.style.setProperty('--indent', indent.tabs ? 4 : indent.size);
    status?.paint(own, indent);
  };
  reindent(text);
  host.style.setProperty('--code-size', `${settings.fontSize}px`);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(), keymap.of([...indentKeys({ indent: () => indent, keep: () => own.keepIndent }), ...historyKeymap, ...standardKeymap]), numbers.of(numbersFor(settings)), wrapping.of(wrapFor(settings)), syntax.of([]), marking.of(markingFor(settings)), guiding.of(guidingFor(settings)), marksField, flashField, foundField,
        bidi, EditorView.perLineTextDirection.of(true),
        EditorState.readOnly.of(!editable), EditorView.editable.of(editable),
        EditorView.updateListener.of((update) => {
          // Typing during an IME composition is the person's once it ends.
          if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromDisk)) || (composed && !view.composing)) {
            composed = view.composing;
            if (!composed) {
              onEdit();
              clearTimeout(changeTimer);
              changeTimer = setTimeout(onChange, CHANGE_MS);
            }
          }
          // Lines measured as they scroll into view move what is below them.
          if ((update.heightChanged || update.geometryChanged) && !update.docChanged) onLayout();
          if (update.selectionSet || update.focusChanged || update.geometryChanged) bubble?.place();
          if (update.selectionSet || update.docChanged) status?.update();
          if (update.docChanged && foundIn) {
            clearTimeout(refind);
            refind = setTimeout(() => finder.changed(), 100); // not on every key
          }
        }),
      ],
    }),
  });

  // The file's language, by its name, loads after the text is shown; no language, no colour.
  // Not `color`, no colour either (web/views/index.js: a long run is parsed again on each key).
  const language = color ? LanguageDescription.matchFilename(languages, name) : null;
  language?.load().then((support) => {
    if (!destroyed) view.dispatch({ effects: syntax.reconfigure([support, syntaxHighlighting(defaultHighlightStyle)]) });
  }, () => {});

  // ---- find: in the text ----

  const foundState = () => {
    const { from, to } = view.state.selection.main;
    return { count: found.length, current: found.findIndex(([f, t]) => f === from && t === to) + 1 };
  };
  const paintFound = () => {
    const { current } = foundState();
    view.dispatch({ effects: setFound.of(Decoration.set(found.map(([from, to], i) => Decoration.mark({ class: i + 1 === current ? 'pj-found pj-found-current' : 'pj-found' }).range(from, to)))) });
  };
  const search = {
    find(next) {
      query = next;
      found = matches(view.state.doc.toString(), query);
      foundIn = query ? view.state.doc : null;
      paintFound();
      return foundState();
    },
    step(back) {
      if (found.length === 0) return foundState();
      const { from, to } = view.state.selection.main;
      const same = ([f, t]) => f === from && t === to;
      const i = back ? found.findLastIndex((r) => r[1] <= from && !same(r)) : found.findIndex((r) => r[0] >= to && !same(r));
      const [anchor, head] = found.at(i === -1 ? (back ? -1 : 0) : i);
      view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { yMargin: 80 }) });
      paintFound();
      return foundState();
    },
    replace(text, all) {
      const { from, to } = view.state.selection.main;
      const targets = all ? found : found.filter(([f, t]) => f === from && t === to);
      if (!editable || targets.length === 0) return search.step(false);
      const changes = view.state.changes(targets.map(([f, t]) => ({ from: f, to: t, insert: text })));
      view.dispatch({ changes, selection: { anchor: changes.mapPos(targets.at(-1)[1], 1) }, userEvent: 'input.replace' });
      search.find(query);
      return all ? foundState() : search.step(false);
    },
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus: () => view.focus(),
  };
  finder = createFind(search, { host, editable });

  if (editable && onComment) bubble = createBubble(view, { stage, host, onComment });
  if (editable) {
    status = createStatusBar(view, stage.parentElement, saveSettings);
    status.paint(own, indent);
  }

  // The doc's text, read out once per version of it.
  // CodeMirror's lines end in "\n" whatever the text's do; a text whose every line break is "\r\n" is
  // written back so, and its offsets are moved by one for each line above them (toDoc, toText).
  let crlf = isCrlf(text);
  const toDoc = (offset) => {
    if (!crlf) return offset;
    const { doc } = view.state;
    let low = 1;
    for (let high = doc.lines; low < high;) {
      const mid = (low + high + 1) >> 1;
      if (doc.line(mid).from + mid - 1 <= offset) low = mid;
      else high = mid - 1;
    }
    return Math.min(offset - (low - 1), doc.line(low).to);
  };
  const toText = (at) => (crlf ? at + view.state.doc.lineAt(at).number - 1 : at);
  let textOf = { doc: view.state.doc, text };
  const currentText = () => {
    if (textOf.doc !== view.state.doc) textOf = { doc: view.state.doc, text: view.state.doc.sliceString(0, view.state.doc.length, crlf ? '\r\n' : '\n') };
    return textOf.text;
  };

  let painted = null; // { doc, marks } last drawn, so a repaint that would draw the same is skipped

  const clickMark = (event) => {
    const mark = event.target.closest?.('[data-thread]');
    if (mark) onMarkClick(mark.dataset.thread);
  };
  host.addEventListener('click', clickMark);

  /**
   * Show `next`, outside the human's undo history, as `ops` change the text
   * shown (when given; else as diffOps finds), so the caret stays at its
   * character; flagged `by` for a while, if given; anything but a buddy's
   * change (`buddy`) also glows.
   */
  function applyText(next, { by = null, buddy = false, ops = null } = {}) {
    const before = currentText();
    const lf = (s) => s.replaceAll('\r\n', '\n');
    const changes = view.state.changes(ops && isCrlf(next) === crlf
      ? ops.map(({ from, to, insert }) => ({ from: toDoc(from), to: toDoc(to), insert: lf(insert) }))
      : diffOps(lf(before), lf(next)));
    crlf = isCrlf(next);
    textOf = { doc: view.state.doc, text: next };
    if (changes.empty) return; // only how lines end changed
    // The line at the top of what is shown, which the page scrolls past.
    const scroller = host.closest('.pj-canvas') ?? document.scrollingElement;
    const shown = view.lineBlockAtHeight(scroller.getBoundingClientRect().top - view.documentTop);
    const flashId = Symbol('flash');
    const flashes = [];
    if (by) {
      const added = [];
      changes.iterChanges((_fromA, _toA, from, to) => added.push([from, to]));
      if (!buddy) flashes.push(...added.filter(([from, to]) => from < to).map(([from, to]) => Decoration.mark({ class: 'pj-flash', flashId }).range(from, to)));
      // The flag at the start of the word the change begins in.
      const at = added[0][0];
      const word = view.state.update({ changes }).state.wordAt(at);
      flashes.push(Decoration.widget({ widget: new Flag(by, buddy ? buddyColor(by) : null), side: -1, flashId }).range(word && word.from < at ? word.from : at));
    }
    view.dispatch({
      changes,
      effects: flashes.length > 0 ? addFlash.of(flashes) : [],
      annotations: [Transaction.addToHistory.of(false), fromDisk.of(true)],
    });
    // It keeps its place on screen, whatever came or went above it.
    scroller.scrollTop += view.lineBlockAt(changes.mapPos(shown.from, 1)).top - shown.top;
    textOf = { doc: view.state.doc, text: next };
    reindent(next);
    if (flashes.length > 0) setTimeout(() => view.dispatch({ effects: dropFlash.of(flashId) }), FLASH_MS);
  }

  return {
    // ---- the view interface (see web/views/markdown/view.js) ----

    getText: currentText,
    applyText,
    composing: () => view.composing,
    setMarks(marks) {
      if (painted?.doc === view.state.doc && JSON.stringify(painted.marks) === JSON.stringify(marks)) return;
      painted = { doc: view.state.doc, marks };
      view.dispatch({ effects: setMarks.of(decorations(marks, toDoc)) });
      onLayout();
    },
    selection() {
      const { from, to } = view.state.selection.main;
      return { from: toText(from), to: toText(to) };
    },
    // Lines outside the viewport are not drawn: their tops are where they would be.
    tops: (offsets) => offsets.map((offset) => {
      const at = toDoc(offset);
      return view.coordsAtPos(at)?.top ?? view.documentTop + view.lineBlockAt(at).top;
    }),
    scrollTo(at) {
      view.dispatch({ effects: EditorView.scrollIntoView(toDoc(at), { y: 'center' }) });
    },
    focus: () => view.focus(),
    /** The view's settings changed. */
    applySettings(next) {
      own = next;
      host.style.setProperty('--code-size', `${next.fontSize}px`);
      reindent(currentText());
      view.dispatch({ effects: shown(next) });
    },
    undo: () => undo(view),
    redo: () => redo(view),
    destroy() {
      destroyed = true;
      delete stage.dataset.plain;
      clearTimeout(changeTimer);
      clearTimeout(refind);
      host.removeEventListener('click', clickMark);
      finder.destroy();
      bubble?.destroy();
      status?.destroy();
      view.destroy();
    },
  };
}

// A Comment button over the selection while the editor has focus, as in the
// Markdown view's bubble; hidden while the pointer is still selecting.
function createBubble(view, { stage, host, onComment }) {
  const template = document.createElement('template');
  template.innerHTML = `<div class="pj-bubble" role="toolbar" aria-label="Selection" hidden>
    <button type="button" class="pj-bubble-comment" data-action="comment" data-icon="comment" data-tip="Comment" data-keys="Mod+Alt+M">Comment</button>
  </div>`;
  hydrateIcons(template.content);
  const bubble = template.content.firstElementChild;
  stage.append(bubble);
  const canvas = stage.parentElement; // scrolls the page
  const page = host.closest('.pj-page');
  const done = new AbortController();
  const { signal } = done;
  let pointerDown = false;

  function place() {
    const { from, to, empty } = view.state.selection.main;
    const start = !pointerDown && !empty && view.hasFocus && view.coordsAtPos(from, 1);
    const end = start && view.coordsAtPos(to, -1);
    if (!end) {
      bubble.hidden = true;
      return;
    }
    bubble.hidden = false;
    const stageRect = stage.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = bubble;
    const top = Math.min(start.top, end.top);
    const center = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
    const left = Math.min(Math.max(center - width / 2, pageRect.left + 8), pageRect.right - width - 8);
    const above = top - height - 10 > canvas.getBoundingClientRect().top;
    bubble.style.left = `${left - stageRect.left}px`;
    bubble.style.top = `${(above ? top - height - 10 : Math.max(start.bottom, end.bottom) + 10) - stageRect.top}px`;
    bubble.dataset.side = above ? 'above' : 'below';
  }

  // The button comments without taking the editor's selection.
  bubble.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (event.target.closest('button')) onComment();
  }, { signal });
  document.addEventListener('mousedown', (event) => {
    if (host.contains(event.target)) pointerDown = true;
  }, { signal });
  document.addEventListener('mouseup', () => {
    if (!pointerDown) return;
    pointerDown = false;
    place();
  }, { signal });
  canvas.addEventListener('scroll', () => {
    if (!bubble.hidden) place();
  }, { passive: true, signal });

  return {
    place,
    destroy() {
      done.abort();
      bubble.remove();
    },
  };
}

// The page's marks as decorations: commented text, and a revision's new
// text marked and the text it removed struck through before it.
function decorations(marks, toDoc) {
  const ranges = [];
  for (const mark of marks) {
    if (mark.kind === 'cursor') {
      ranges.push(Decoration.widget({ widget: new Cursor(mark), side: 1 }).range(toDoc(mark.at)));
      continue;
    }
    const from = toDoc(mark.from);
    const to = toDoc(mark.to);
    if (mark.kind === 'comment') {
      if (from < to) {
        ranges.push(Decoration.mark({ class: mark.active ? 'pj-hl pj-hl-active' : 'pj-hl', attributes: { 'data-thread': mark.id } }).range(from, to));
      }
      continue;
    }
    const { removed, by, replay } = mark;
    const className = (kind) => `${by ? (kind === 'ins' ? 'pj-buddy-edit' : 'pj-buddy-del') : `pj-mark-${kind}`}${replay ? ' pj-replay' : ''}`;
    const style = by ? `--buddy: ${buddyColor(by)}` : '';
    if (removed) ranges.push(Decoration.widget({ widget: new Removed(removed, className('del'), style, replay), side: -1 }).range(from));
    if (from < to) ranges.push(Decoration.mark({ class: className('ins'), attributes: { style, 'data-replay': String(replay) } }).range(from, to));
  }
  return Decoration.set(ranges, true);
}

// Text a revision removed, struck through where it was; a new `replay` draws it again.
class Removed extends WidgetType {
  constructor(text, className, style, replay) {
    super();
    Object.assign(this, { text, className, style, replay });
  }

  eq(other) {
    return other.text === this.text && other.className === this.className && other.style === this.style && other.replay === this.replay;
  }

  toDOM() {
    const node = document.createElement('del');
    node.className = this.className;
    node.style.cssText = this.style;
    node.textContent = this.text;
    return node;
  }
}

// A buddy's cursor (see cursorNode).
class Cursor extends WidgetType {
  constructor(mark) {
    super();
    this.mark = mark;
  }

  eq(other) {
    return other.mark.by === this.mark.by && other.mark.working === this.mark.working;
  }

  toDOM() {
    return cursorNode(this.mark);
  }
}

// Who made a change, over its start; in a buddy's colour (`color`) for a buddy.
class Flag extends WidgetType {
  constructor(name, color) {
    super();
    Object.assign(this, { name, color });
  }

  eq(other) {
    return other.name === this.name && other.color === this.color;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'pj-flag';
    if (this.color) wrap.style.cssText = `--buddy: ${this.color}; --buddy-ink: #1f1d24`;
    const label = document.createElement('span');
    label.className = 'pj-flag-label';
    label.textContent = this.name;
    wrap.append(label);
    return wrap;
  }
}

// Whether every line break of `text` is "\r\n".
const isCrlf = (text) => text.includes('\r\n') && !/\r(?!\n)|(?<!\r)\n/.test(text);
