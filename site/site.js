// The header's theme switch: light or dark, starting from the system's.
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
for (const button of document.querySelectorAll('[data-theme-pick]')) {
  button.setAttribute('aria-checked', String((button.dataset.themePick === 'dark') === dark));
  button.addEventListener('click', () => {
    document.documentElement.dataset.theme = button.dataset.themePick;
    for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-checked', String(b === button));
  });
}
