// Ресурсы принадлежат экрану, а не всему приложению. При SPA-переходе
// освобождаем глобальные подписки, observers и таймеры старого редактора.
let current;
export class PageScope {
  constructor(body) {
    this.body = body;
    this.document = new Proxy(globalThis.document, {
      set(target, key, value) {
        return Reflect.set(target, key, value, target);
      },
      get(target, key) {
        if (key === 'body') return body;
        if (key === 'getElementById') return (id) => body.querySelector('#' + CSS.escape(id));
        if (key === 'querySelector' || key === 'querySelectorAll') return body[key].bind(body);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.controller = new AbortController();
    this.cleanups = new Set();
    this.requests = new Set();
    this.disposed = false;
  }
  activate() {
    current = this;
  }
  ready() {
    // Общая навигация остаётся доступной при загрузке. Редактор освобождает
    // свой холст независимо от загрузки истории чата.
    for (const element of this.initializing || []) element.inert = false;
    this.initializing = [];
  }
  dispose() {
    this.disposed = true;
    this.controller.abort();
    for (const cleanup of [...this.cleanups].reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error('Освобождение экрана:', error);
      }
    }
    this.cleanups.clear();
    if (current === this) current = undefined;
  }
}
export function onPageCleanup(cleanup) {
  const scope = current;
  if (scope && !scope.disposed) scope.cleanups.add(cleanup);
  return cleanup;
}
export function listen(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return onPageCleanup(() => target.removeEventListener(type, listener, options));
}
export function pageTimeout(callback, delay, ...args) {
  const scope = current;
  const timer = globalThis.setTimeout(() => {
    scope?.cleanups.delete(cleanup);
    if (!scope?.disposed) callback(...args);
  }, delay);
  const cleanup = onPageCleanup(() => clearTimeout(timer));
  return timer;
}
export function pageInterval(callback, delay, ...args) {
  const scope = current;
  const timer = globalThis.setInterval(() => {
    if (!scope?.disposed) callback(...args);
  }, delay);
  onPageCleanup(() => clearInterval(timer));
  return timer;
}
export class PageResizeObserver extends (globalThis.ResizeObserver || class {}) {
  constructor(callback) {
    super(callback);
    onPageCleanup(() => this.disconnect());
  }
}
export class PageIntersectionObserver extends (globalThis.IntersectionObserver || class {}) {
  constructor(callback, options) {
    super(callback, options);
    onPageCleanup(() => this.disconnect());
  }
}

export function pageScope() {
  return current;
}
