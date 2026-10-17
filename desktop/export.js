// File > Export: save the open doc as PDF, Word or a web page where the user
// picks in a native Save dialog. PDF is the export's HTML page printed by a
// hidden window with scripts off. The page never sees the path; it can only
// ask to open or show the file it exported last.

import { BrowserWindow, dialog, shell } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FORMATS, checkExportOptions, exportDoc, exportName } from '../src/export/index.js';

const PRINT_TIMEOUT_MS = 60_000;
const lastExport = new WeakMap(); // doc window → path of its last export

/**
 * Ask where to save `docPath` in `options.format` and write it there.
 * Resolves to { name } of the file written, or null when the user cancels.
 */
export async function exportFromWindow(win, docPath, options) {
  const checked = checkExportOptions(options);
  const { format } = checked;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: `Export as ${FORMATS[format].label}`,
    defaultPath: join(dirname(docPath), exportName(basename(docPath), format)),
    buttonLabel: 'Export',
    filters: [{ name: FORMATS[format].label, extensions: [FORMATS[format].extension] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (canceled || !filePath) return null;
  const result = await exportDoc(docPath, checked);
  await writeFile(filePath, format === 'pdf' ? await printToPdf(result.bytes) : result.bytes);
  lastExport.set(win, filePath);
  return { name: basename(filePath) };
}

/** Open the last export of `win` in its app ('open') or show it in its folder ('reveal'). */
export async function showExport(win, how) {
  const path = lastExport.get(win);
  if (!path) return false;
  if (how === 'reveal') shell.showItemInFolder(path);
  else {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  }
  return true;
}

async function printToPdf(html) {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-export-'));
  const page = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'opendoc-export', spellcheck: false },
  });
  page.webContents.on('will-navigate', (event) => event.preventDefault());
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let timer;
  try {
    const file = join(dir, 'export.html');
    await writeFile(file, html);
    await page.loadFile(file);
    return await Promise.race([
      page.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('printing the PDF took too long')), PRINT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    page.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
