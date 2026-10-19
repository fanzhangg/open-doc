// The Electron app the view contract tests (test/views.test.js) drive: one
// window on the page at VIEWS_PAGE.

import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  window.loadFile(process.env.VIEWS_PAGE);
});
