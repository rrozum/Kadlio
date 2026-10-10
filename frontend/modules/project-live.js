import { pageTimeout, onPageCleanup } from './page-lifecycle.js';
// Объединяем серии серверных событий. Пока есть локальный черновик, его DOM не заменяем.
export class ProjectLive {
  constructor({ url, isBlocked, onRefresh, onError }) {
    Object.assign(this, { isBlocked, onRefresh, onError });
    this.closed = false;
    this.pending = false;
    this.running = false;
    this.events = new EventSource(url);
    onPageCleanup(() => this.close());
    this.events.onmessage = () => this.schedule(150);
    this.events.onopen = () => this.schedule(150); // сверяем состояние и после переподключения
  }
  schedule(delay = 150) {
    if (this.closed) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = pageTimeout(() => this.refresh(), delay);
  }
  async refresh() {
    if (this.closed || this.running) return;
    if (this.isBlocked()) {
      this.schedule(500);
      return;
    }
    this.pending = false;
    this.running = true;
    try {
      if ((await this.onRefresh()) === false) this.pending = true;
    } catch (error) {
      this.onError?.(error);
      this.pending = true;
    } finally {
      this.running = false;
      if (this.pending) this.schedule(500);
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.events.close();
  }
}
