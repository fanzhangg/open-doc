// npm run lint. Modules depend in one direction: each may import only itself
// and the modules listed for it, and no imports go in a circle.

const allowed = {
  'src/core': [],
  'src/markdown': ['src/core'],
  'src/rules': ['src/core', 'src/markdown'],
  'src/store': ['src/core'],
  'src/host': ['src/core', 'src/rules', 'src/store'],
  web: ['src/core', 'src/rules', 'src/markdown'], // reaches desktop only over IPC
  desktop: ['src/core', 'src/store', 'src/host'],
};

export default {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    ...Object.entries(allowed).map(([module, deps]) => ({
      name: `${module.replace('/', '-')}-imports`,
      comment: `${module} may import only ${deps.join(', ') || 'nothing else in the project'}`,
      severity: 'error',
      from: { path: `^${module}/` },
      to: { dependencyTypes: ['local'], pathNot: [module, ...deps].map((m) => `^${m}/`) },
    })),
  ],
  options: { doNotFollow: { path: 'node_modules' } },
};
