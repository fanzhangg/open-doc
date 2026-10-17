// Print an exported HTML page to PDF with an installed Chrome, Edge or
// Chromium, run headless (the page's own policy keeps scripts off). Used by
// `opendoc export --to pdf`.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 60_000;

export class BrowserError extends Error {}

/** Where a Chromium browser is: OPENDOC_BROWSER, then the usual places. Null when none is found. */
export function findBrowser(env = process.env, platform = process.platform) {
  if (env.OPENDOC_BROWSER) return env.OPENDOC_BROWSER;
  const candidates = [];
  if (platform === 'win32') {
    for (const root of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
    }
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        candidates.push(join(dir, name));
      }
    }
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Print `html` to the PDF file `outPath`. */
export async function printToPdf(html, outPath, { browser = findBrowser() } = {}) {
  if (!browser) {
    throw new BrowserError('PDF export needs Chrome, Edge or Chromium; set OPENDOC_BROWSER to one, or export from the editor');
  }
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-pdf-'));
  try {
    const page = join(dir, 'page.html');
    const pdf = join(dir, 'page.pdf');
    await writeFile(page, html);
    await run(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'profile')}`,
      `--print-to-pdf=${pdf}`, pathToFileURL(page).href,
    ]);
    if (!(await stat(pdf).catch(() => null))?.size) throw new BrowserError(`${browser} did not write the PDF`);
    await copyFile(pdf, outPath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new BrowserError('the browser took too long to print the PDF'));
    }, TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new BrowserError(`could not start ${command}: ${error.message}`));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
