// The Export dialog (header button, File > Export, Mod+Shift+E): pick PDF,
// Word or a web page, which comments go in, and the paper. The choices are
// remembered in the settings. The desktop app asks where to save and can
// open the file after; in a browser tab Word and web pages download, and a
// PDF goes through the browser's print dialog ("Save as PDF").

import { api } from './api.js';
import { icon } from './icons.js';

const EXTENSIONS = { pdf: 'pdf', docx: 'docx', html: 'html' };
const WHERE = { pdf: 'listed after the text', docx: 'as Word comments', html: 'in a column beside the text' };
// Regions that use US Letter paper; everywhere else uses A4 (as src/export/index.js).
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV', 'NI', 'BZ']);
const TOAST_MS = 8000;
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * @param {{ settings: ReturnType<typeof import('./settings.js').createSettings>,
 *           flushSave: () => Promise<void>, sidecar: () => object | null }} options
 */
export function createExport({ settings, flushSave, sidecar }) {
  const dialog = document.querySelector('.od-export');
  const form = dialog.querySelector('form');
  const hint = dialog.querySelector('.od-export-hint');
  const paperRow = dialog.querySelector('.od-export-paper');
  const error = dialog.querySelector('.od-export-error');
  const submit = dialog.querySelector('[data-action="export"]');
  const frame = document.querySelector('.od-print-frame');
  const desktop = window.opendocDesktop;
  const toast = createToast(desktop);
  let choice = null; // { format, comments, paper }
  let busy = false;

  function open() {
    if (dialog.open) return;
    const s = settings.get();
    choice = { format: s.exportFormat, comments: s.exportComments, paper: s.exportPaper ?? regionPaper() };
    dialog.querySelector('.od-export-doc').textContent = docName();
    error.hidden = true;
    paint();
    dialog.showModal();
    dialog.querySelector(`[data-format="${choice.format}"]`).focus();
  }

  function paint() {
    const mark = (attr, value) => {
      for (const button of dialog.querySelectorAll(`[data-${attr}]`)) button.setAttribute('aria-checked', String(button.dataset[attr] === value));
    };
    mark('format', choice.format);
    mark('comments', choice.comments);
    mark('paper', choice.paper);
    paperRow.hidden = choice.format === 'html';
    hint.textContent = commentHint();
    submit.textContent = desktop ? 'Export…' : choice.format === 'pdf' ? 'Print…' : 'Download';
  }

  function commentHint() {
    if (choice.comments === 'none') return 'Just the text';
    const threads = sidecar()?.threads ?? [];
    const count = choice.comments === 'all' ? threads.length : threads.filter((t) => t.status === 'open').length;
    if (count === 0) return choice.comments === 'all' ? 'This doc has no comments' : 'This doc has no open comments';
    const what = choice.comments === 'all' ? (count === 1 ? 'thread' : 'threads') : (count === 1 ? 'open thread' : 'open threads');
    return `${count} ${what}, ${WHERE[choice.format]}`;
  }

  async function run() {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    const { format, comments, paper } = choice;
    try {
      await flushSave();
      const s = settings.get();
      if (s.exportFormat !== format || s.exportComments !== comments || s.exportPaper !== paper) {
        settings.set({ exportFormat: format, exportComments: comments, exportPaper: paper });
      }
      if (desktop) {
        const saved = await desktop.exportDoc({ format, comments, paper });
        if (!saved) return; // the Save dialog was cancelled: the choices stay open
        dialog.close();
        toast.show(`Exported ${saved.name}`, { file: true });
      } else if (format === 'pdf') {
        const html = await (await api.exportDoc({ format, comments, paper })).text();
        dialog.close();
        printHtml(html);
      } else {
        const name = docName().replace(/\.(md|markdown)$/i, '') + '.' + EXTENSIONS[format];
        const blob = await (await api.exportDoc({ format, comments, paper })).blob();
        download(blob, name);
        dialog.close();
        toast.show(`Downloaded ${name}`);
      }
    } catch (e) {
      error.textContent = `Couldn't export: ${e.message}`;
      error.hidden = false;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  // The page prints in a frame where nothing runs (its sandbox allows no
  // scripts), then the frame is emptied.
  function printHtml(html) {
    frame.onload = () => {
      frame.onload = null;
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) {
        toast.show(`Couldn't print: ${e.message}`, { error: true });
      }
      setTimeout(() => frame.removeAttribute('srcdoc'), 1000);
    };
    frame.srcdoc = html;
  }

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) return dialog.close(); // backdrop
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'close') dialog.close();
    else if (button.dataset.format) choice.format = button.dataset.format;
    else if (button.dataset.comments) choice.comments = button.dataset.comments;
    else if (button.dataset.paper) choice.paper = button.dataset.paper;
    else return;
    paint();
  });
  // Left and right move within a group of choices, as in a radio group.
  dialog.addEventListener('keydown', (event) => {
    const button = event.target.closest?.('[role="radio"]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const group = [...button.parentElement.querySelectorAll('[role="radio"]')];
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = group[(group.indexOf(button) + step + group.length) % group.length];
    next.click();
    next.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });

  document.querySelector('.od-export-toggle').addEventListener('click', open);
  document.addEventListener('keydown', (event) => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      open();
    }
  });

  return { open };
}

function createToast(desktop) {
  const node = document.querySelector('.od-toast');
  const openButton = node.querySelector('[data-action="open"]');
  const revealButton = node.querySelector('[data-action="reveal"]');
  revealButton.textContent = mac ? 'Show in Finder' : 'Show in folder';
  let timer = 0;

  function hide() {
    clearTimeout(timer);
    node.hidden = true;
  }

  node.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'dismiss') hide();
    else if (action === 'open' || action === 'reveal') {
      (action === 'open' ? desktop.openExport() : desktop.revealExport())
        .catch((e) => show(`Couldn't open it: ${e.message}`, { error: true }));
      hide();
    }
  });
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    timer = setTimeout(hide, TOAST_MS / 2);
  });

  function show(text, { file = false, error = false } = {}) {
    clearTimeout(timer);
    node.dataset.state = error ? 'error' : 'done';
    node.querySelector('.od-toast-icon').replaceChildren(icon(error ? 'alert' : 'check'));
    node.querySelector('.od-toast-text').textContent = text;
    openButton.hidden = revealButton.hidden = !(file && desktop);
    node.hidden = false;
    timer = setTimeout(hide, TOAST_MS);
  }

  return { show };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function docName() {
  return document.querySelector('.od-doc-name').textContent;
}

function regionPaper() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return LETTER_REGIONS.has(region) ? 'letter' : 'a4';
  } catch {
    return 'a4';
  }
}
