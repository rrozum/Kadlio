// Синхронный скрипт в head восстанавливает тему до первого отображения страницы.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('presentations.theme') === 'light') theme = 'light';
  } catch {}
  document.documentElement.dataset.uiTheme = theme;
  document.documentElement.style.colorScheme = theme;
})();
