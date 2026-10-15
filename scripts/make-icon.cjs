// Render build/icon.svg to build/icon.png (512x512) with Electron, which
// electron-builder turns into the app icons. Run after changing the SVG:
//   npx electron scripts/make-icon.cjs

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');

app.whenReady().then(() => {
  const svg = readFileSync(join(build, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  let loaded = false;
  win.webContents.on('did-finish-load', () => { loaded = true; });
  win.webContents.on('paint', (_event, _dirty, image) => {
    if (!loaded || image.isEmpty()) return;
    writeFileSync(join(build, 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
    app.quit();
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
