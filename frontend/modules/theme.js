const storageKey = 'presentations.theme';
const svg = (content) =>
  `<svg class="theme-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const sun = svg(
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
);
const moon = svg(
  '<path d="M20.1 15.7A9 9 0 0 1 8.3 3.9a9 9 0 1 0 11.8 11.8Z" fill="currentColor" fill-opacity=".14"/>',
);
let theme = 'dark';
let activeTransition;
// При навигации старый снимок темы больше не соответствует открытому экрану.
document.addEventListener('kadlio:before-navigate', () => activeTransition?.skipTransition());
try {
  if (localStorage.getItem(storageKey) === 'light') theme = 'light';
} catch {}
function applyTheme(value) {
  theme = value === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.uiTheme = theme;
  document.documentElement.style.colorScheme = theme;
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    const label = theme === 'dark' ? 'Светлая' : 'Тёмная';
    button.innerHTML =
      (theme === 'dark' ? sun : moon) + `<span class="theme-label">${label}</span>`;
    button.title = button.ariaLabel = `Включить ${theme === 'dark' ? 'светлую' : 'тёмную'} тему`;
    button.setAttribute('aria-pressed', String(theme === 'light'));
  }
}
applyTheme(theme);
const initialized = new WeakSet();
export function initTheme(button) {
  if (!button || initialized.has(button)) return;
  initialized.add(button);
  button.dataset.themeToggle = '';
  applyTheme(theme);
  button.addEventListener('click', () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      activeTransition?.skipTransition();
      activeTransition = document.startViewTransition(() => applyTheme(next));
    } else applyTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {}
  });
}
window.addEventListener('storage', (event) => {
  if (event.key === storageKey) applyTheme(event.newValue);
});
