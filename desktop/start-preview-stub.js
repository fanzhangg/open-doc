// A stand-in for desktop/preload.cjs so the start window opens in a plain
// browser (scripts/start-preview.js). Sample recent docs and default settings,
// kept in memory: Settings works; New doc, Open… and the recent docs only
// log, since there is no app to open them.

(() => {
  let settings = { name: 'you', face: null, theme: 'system', font: 'sans', width: 'normal', outline: true, wordCount: false, focus: false };
  const recent = [
    { name: 'plan.md', folder: '/Users/you/Documents/launch' },
    { name: 'user-journey.md', folder: '/Users/you/Workplace/open-doc/docs' },
    { name: 'weekly-notes.md', folder: '/Users/you/Documents/notes' },
  ];

  const log = (what) => {
    console.info(`[start preview] ${what} (needs the desktop app)`);
    return Promise.resolve();
  };

  window.opendocDesktop = {
    newDoc: () => log('New doc'),
    open: () => log('Open…'),
    rename: () => log('Rename'),
    setAgentProgram: () => Promise.resolve(false),
    chooseProgram: () => Promise.resolve(null),
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
