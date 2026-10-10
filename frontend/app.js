import { PageScope } from './modules/page-lifecycle.js';
import { installNavigation, navigate } from './modules/navigation.js';

// Загружаем только известные экраны приложения. HTML презентации, ответы агента
// и импортированные документы никогда не выбирают исполняемый модуль.
const screens = {
  '/projects': () => import('./projects.js'),
  '/themes': () => import('./themes.js'),
  '/projects/new': () => import('./project-new.js'),
  '/login': () => import('./login.js'),
  editor: () => import('./editor.js'),
  themeEditor: () => import('./theme-editor.js'),
};
function screenFor(url) {
  if (url.searchParams.has('presenter')) return null;
  if (url.pathname === '/') return screens['/projects'];
  if (screens[url.pathname]) return screens[url.pathname];
  if (/^\/projects\/[^/]+$/.test(url.pathname)) return screens.editor;
  if (/^\/themes\/[^/]+$/.test(url.pathname)) return screens.themeEditor;
  return null;
}
let scope,
  currentURL = new URL(location.href),
  busy = false;
let historyIndex = 0;
let initialMount;
let queued;
let navigationEpoch = 0;
history.replaceState({ ...history.state, kadlioIndex: historyIndex }, '');
const parsedPages = new Map();
const stylesheetLinks = () => [...document.head.querySelectorAll('link[rel=stylesheet]')];

async function loadStyles(page) {
  const desired = [...page.head.querySelectorAll('link[rel=stylesheet]')].map((link) => link.href);
  const previous = stylesheetLinks();
  if (
    desired.length === previous.length &&
    desired.every((href, index) => previous[index].href === href)
  )
    return () => {};
  const staged = [];
  try {
    await Promise.all(
      desired.map(
        (href) =>
          new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            // Новые links сразу стоят в нужном порядке. Перемещение уже активного
            // link через append временно отключает CSS и даёт кадр без оформления.
            link.media = 'not all';
            link.onload = resolve;
            link.onerror = () => reject(new Error('Не удалось загрузить оформление.'));
            staged.push(link);
            document.head.append(link);
          }),
      ),
    );
  } catch (error) {
    staged.forEach((link) => link.remove());
    throw error;
  }
  return () => {
    // Меняем каскад одним заданием. Старые links остаются активны всю загрузку,
    // новые используем из браузерного кэша и больше не перемещаем в DOM.
    staged.forEach((link) => {
      link.media = 'all';
    });
    previous.forEach((link) => link.remove());
  };
}

function bindHeader() {
  const button = document.getElementById('logout-button');
  if (!button || button.dataset.spaBound) return;
  button.dataset.spaBound = 'true';
  button.addEventListener('click', async () => {
    // Выход сначала проходит ту же защиту черновика, что и обычная навигация.
    if (!canLeave()) return;
    const response = await fetch('/api/logout', { method: 'POST' });
    if (response.ok) await go('/login', { skipGuard: true });
  });
}
function canLeave() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return (
    !event.defaultPrevented ||
    confirm(
      'Есть несохранённые изменения или незавершённая работа. Покинуть страницу без сохранения?',
    )
  );
}
async function mount(body, url) {
  const screenScope = new PageScope(body);
  scope = screenScope;
  screenScope.activate();
  bindHeader();
  screenScope.initializing = [...body.children].flatMap((element) => {
    if (element.matches('.projects-header, .projects-footer, script, style')) return [];
    if (element.tagName === 'HEADER')
      return [...element.children].filter((child) => !child.matches('.brand'));
    return [element];
  });
  screenScope.initializing.forEach((element) => {
    element.inert = true;
  });
  try {
    const screen = await screenFor(url)();
    if (!screenScope.disposed) await screen.mount(screenScope);
  } finally {
    screenScope.ready();
  }
}
async function pageFor(url) {
  // Кэшируем только шаблоны экранов, без данных презентаций и аккаунта.
  const key = url.pathname + url.search;
  if (parsedPages.has(key)) return parsedPages.get(key).cloneNode(true);
  const response = await fetch(key, {
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Не удалось открыть страницу (' + response.status + ').');
  const finalURL = new URL(response.url);
  if (finalURL.pathname === '/login' && url.pathname !== '/login') return { redirect: finalURL };
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (!page.querySelector('script[src="/app.js"]')) throw new Error('Неподдерживаемая страница.');
  page.body.querySelectorAll('script').forEach((script) => script.remove());
  parsedPages.set(key, page.cloneNode(true));
  return page;
}
async function go(target, { pop = false, skipGuard = false, nextIndex } = {}) {
  const url = new URL(target, location.href);
  if (!pop) currentURL = new URL(location.href);
  if (url.origin !== location.origin || !screenFor(url)) {
    location.assign(url.href);
    return;
  }
  if (url.pathname === currentURL.pathname && url.search === currentURL.search) {
    if (!pop && url.hash !== location.hash) {
      history.pushState({ kadlioIndex: ++historyIndex }, '', url);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
    currentURL = url;
    if (pop) historyIndex = nextIndex;
    return;
  }
  if (busy) {
    queued = { target, options: { pop, skipGuard, nextIndex } };
    return;
  }
  if (!skipGuard && !canLeave()) {
    if (pop) history.go(historyIndex - nextIndex);
    return;
  }
  busy = true;
  const epoch = ++navigationEpoch;
  document.documentElement.setAttribute('aria-busy', 'true');
  try {
    const page = await pageFor(url);
    if (page.redirect) {
      busy = false;
      return go(page.redirect, { skipGuard: true });
    }
    const commitStyles = await loadStyles(page);
    await screenFor(url)();
    while (scope.requests.size) await Promise.allSettled([...scope.requests]);
    const commit = async () => {
      // Перемещаем общую оболочку только в момент commit, без пустой шапки
      // на старом экране во время ожидания API или загрузки модулей.
      const oldHeader = document.querySelector('.projects-header');
      const newHeader = page.body.querySelector('.projects-header');
      if (oldHeader && newHeader) {
        const active = newHeader.querySelector('[aria-current=page]')?.getAttribute('href');
        oldHeader.querySelectorAll('.library-nav a').forEach((link) => {
          if (link.getAttribute('href') === active) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        });
        newHeader.replaceWith(oldHeader);
      }
      const oldFooter = document.querySelector('.projects-footer');
      const newFooter = page.body.querySelector('.projects-footer');
      if (oldFooter && newFooter) newFooter.replaceWith(oldFooter);
      scope.dispose();
      document.body.replaceWith(document.adoptNode(page.body));
      commitStyles();
      document.title = page.title;
      if (!pop) history.pushState({ kadlioIndex: ++historyIndex }, '', url);
      else historyIndex = nextIndex;
      currentURL = url;
      window.scrollTo(0, 0);
      const initialized = mount(document.body, url);
      // Транзакция маршрута завершена. Фоновая инициализация экрана не должна
      // запрещать следующий переход: dispose отменит её чтения при уходе.
      busy = false;
      runQueued();
      await initialized;
    };
    // Снимки всего документа при навигации оставляют старые модалки поверх
    // нового холста и временно блокируют iframe. Анимируем только живой контент.
    document.dispatchEvent(new Event('kadlio:before-navigate'));
    page.body.dataset.routeEnter = '';
    await commit();
    if (epoch === navigationEpoch)
      document.dispatchEvent(new CustomEvent('kadlio:navigated', { detail: { url: url.href } }));
  } catch (error) {
    if (epoch !== navigationEpoch) return;
    console.error(error);
    if (pop) history.go(historyIndex - nextIndex);
    alert(error.message || 'Не удалось открыть страницу. Попробуйте ещё раз.');
  } finally {
    if (epoch === navigationEpoch) {
      busy = false;
      document.documentElement.removeAttribute('aria-busy');
      runQueued();
    }
  }
}
function runQueued() {
  if (!queued) return;
  const next = queued;
  queued = undefined;
  go(next.target, next.options);
}
document.addEventListener('kadlio:route-replaced', () => {
  currentURL = new URL(location.href);
});
installNavigation(go);
document.addEventListener('click', (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link = event.target.closest('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !screenFor(url)) return;
  event.preventDefault();
  navigate(url.href);
});
window.addEventListener('popstate', (event) => {
  const nextIndex = event.state?.kadlioIndex ?? 0;
  go(location.href, { pop: true, nextIndex });
});
document.documentElement.setAttribute('aria-busy', 'true');
const initialBody = document.body;
initialMount = mount(initialBody, currentURL);
try {
} finally {
  if (document.body === initialBody && !busy) document.documentElement.removeAttribute('aria-busy');
}
