// The Electron app the view contract tests (test/views.test.js) drive: one
// window on the page at VIEWS_PAGE. Smooth scrolling is off, so a view's
// scrollTo lands at once: on a slow CI machine its animation can outlast
// the test's wait.

import { app, BrowserWindow } from 'electron';

app.commandLine.appendSwitch('disable-smooth-scrolling');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  window.loadFile(process.env.VIEWS_PAGE);
});
