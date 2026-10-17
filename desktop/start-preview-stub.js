// A stand-in for desktop/preload.cjs so the start window opens in a plain
// browser (scripts/start-preview.js). Sample recent docs and folders and
// default settings, kept in memory: Settings works; New doc, Open…, Open
// Folder… and the recent list only log, since there is no app to open them.

(() => {
  let settings = { name: 'you', theme: 'system', font: 'sans', width: 'normal', outline: true, wordCount: false, focus: false };
  const recent = [
    { name: 'plan.md', folder: '/Users/you/Documents/launch', kind: 'doc' },
    { name: 'docs', folder: '/Users/you/Workplace/open-doc', kind: 'folder' },
    { name: 'weekly-notes.md', folder: '/Users/you/Documents/notes', kind: 'doc' },
  ];

  const log = (what) => {
    console.info(`[start preview] ${what} (needs the desktop app)`);
    return Promise.resolve();
  };

  window.opendocDesktop = {
    newDoc: () => log('New doc'),
    open: () => log('Open…'),
    openFolder: () => log('Open Folder…'),
    rename: () => log('Rename'),
    setAgentProgram: () => Promise.resolve(false),
    openRecent: (index) => log(`Open ${recent[index]?.name}`),
    recent: () => Promise.resolve(recent.map((doc) => ({ ...doc }))),
    onRecentChanged: () => {},
    settings: () => Promise.resolve({ ...settings }),
    saveSettings: (patch) => {
      settings = { ...settings, ...patch };
      return Promise.resolve({ ...settings });
    },
    onSettingsChanged: () => {},
    onCommand: () => {},
  };
})();
