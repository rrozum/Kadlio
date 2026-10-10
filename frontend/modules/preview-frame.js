import { PageResizeObserver, onPageCleanup } from './page-lifecycle.js';

// Превью — самостоятельный документ. Его нельзя показывать до загрузки CSS,
// шрифтов и декодирования изображений: первый кадр иначе имеет чужие цвета.
export function mountPreviewFrame(
  container,
  { html, title, frame = document.createElement('iframe') },
) {
  let disposed = false;
  frame.title = title;
  frame.tabIndex = -1;
  frame.loading = 'lazy';
  frame.width = '1280';
  frame.height = '720';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.visibility = 'hidden';
  const status = document.createElement('div');
  status.className = 'preview-loading';
  status.setAttribute('role', 'status');
  status.innerHTML =
    '<span class="loading-spinner" aria-hidden="true"></span><span>Загружаем превью</span>';
  container.setAttribute('aria-busy', 'true');
  const resize = () => {
    frame.style.transform = 'scale(' + container.clientWidth / 1280 + ')';
  };
  const observer = new PageResizeObserver(resize);
  observer.observe(container);
  let timer;
  async function loaded() {
    try {
      const doc = frame.contentDocument;
      const slide = doc?.querySelector('.slide');
      if (!slide && doc?.URL === 'about:blank') return; // Начальный load ленивого iframe.
      if (!slide) throw new Error('Нет слайда');
      // Инициируем layout скрытого документа до fonts.ready: используются
      // именно шрифты слайда, а не пока ещё пустого iframe.
      slide.getBoundingClientRect();
      await Promise.race([
        Promise.all([
          doc.fonts?.ready,
          ...[...doc.images].map((image) => image.decode().catch(() => {})),
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Превью не готово')), 10000);
        }),
      ]);
      clearTimeout(timer);
      if (disposed || !container.isConnected || frame.contentDocument !== doc) return;
      resize();
      // CSS и изображения готовы; масштаб задаётся до первого видимого кадра.
      frame.style.visibility = 'visible';
      status.remove();
      container.setAttribute('aria-busy', 'false');
    } catch {
      if (disposed) return;
      status.textContent = 'Превью недоступно';
      container.setAttribute('aria-busy', 'false');
    }
  }
  frame.addEventListener('load', loaded);
  if (html !== undefined) frame.srcdoc = html;
  container.replaceChildren(status, frame);
  resize();
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    observer.disconnect();
    frame.removeEventListener('load', loaded);
  };
  onPageCleanup(dispose);
  return dispose;
}
