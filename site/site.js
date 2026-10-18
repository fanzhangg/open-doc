// The header: the Development menu, and the theme switch (light or dark,
// starting from the system's).
const root = document.documentElement;
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.querySelector('.site-theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
});

const dev = document.querySelector('.site-dev > button');
const menu = document.getElementById(dev.getAttribute('aria-controls'));
const open = (on) => {
  dev.setAttribute('aria-expanded', String(on));
  menu.hidden = !on;
};
dev.addEventListener('click', () => open(menu.hidden));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.site-dev')) open(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    open(false);
    dev.focus();
  }
});
