// The browser the relay test (test/relay.test.js) opens a teammate's page
// in: one window on RELAY_PAGE.

import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } }).loadURL(process.env.RELAY_PAGE);
});
