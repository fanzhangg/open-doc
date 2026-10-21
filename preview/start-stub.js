// A stand-in for desktop/preload.cjs so the start window opens in a plain
// browser (preview/build.js). Sample recent projects and default
// settings, kept in memory: Settings works; Open Project and
// the recent list only log, since there is no app to open them.

(() => {
  let settings = { name: 'you', theme: 'system', agent: 'claude' };
  const recent = [
    { name: 'open-doc', folder: '~/Workplace' },
    { name: 'docs', folder: '~/Workplace/open-doc' },
    { name: 'Board Games', folder: '~/Library/CloudStorage/GoogleDrive/My Drive/2026' },
  ];

  const log = (what) => {
    console.info(`[start preview] ${what} (needs the desktop app)`);
    return Promise.resolve();
  };

  window.opendocDesktop = {
    openFolder: () => log('Open project…'),
    agentScripts: () => Promise.resolve({ agents: [{ id: 'claude', name: 'Claude Code', about: '', settings: [] }, { id: 'codex', name: 'Codex', about: '', settings: [] }], shipped: ['claude', 'codex'], folder: '~/Library/Application Support/OpenDoc/agents' }),
    resetAgentScript: (name) => log(`Reset ${name}`),
    showAgents: () => log('Show folder'),
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
