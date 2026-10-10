import { pageTimeout } from '../modules/page-lifecycle.js';
import { isSelectableElement } from './blocks.js';

const label = (element) => {
  const tag = element.localName,
    id = element.id ? ' #' + element.id : '',
    text = (element.innerText || element.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 32);
  return tag + id + (text ? ' · ' + text : '');
};

export class SlideLayers {
  constructor({ parent, getCanvas, onThemeEdit }) {
    Object.assign(this, { parent, getCanvas, onThemeEdit });
    this.records = new Map();
    parent.innerHTML =
      '<summary>Слои слайда</summary><p class="layers-hint">Alt + клик — вложенный элемент. Замок защищает всю группу.</p><div class="layers-list" role="list" aria-label="Элементы слайда"></div><p class="layers-limit" hidden>Показаны первые 400 элементов. Остальные доступны в HTML слайда.</p>';
    this.list = parent.querySelector('.layers-list');
    this.theme = document.createElement('div');
    this.theme.className = 'layer-row theme-layer-row';
    this.theme.innerHTML =
      '<button type="button" class="layer-select" aria-label="Выбрать защищённую тему">Тема слайда</button><button type="button" class="layer-lock" title="Открыть отдельный редактор темы" aria-label="Редактировать тему">🔒</button>';
    this.theme
      .querySelector('.layer-select')
      .addEventListener('click', () => this.getCanvas().selectTheme());
    this.theme.querySelector('.layer-lock').addEventListener('click', () => this.onThemeEdit());
    this.list.append(this.theme);
  }
  schedule() {
    if (!this.timer)
      this.timer = pageTimeout(() => {
        this.timer = null;
        this.refresh();
      }, 100);
  }
  refresh() {
    const canvas = this.getCanvas(),
      root = canvas.root;
    if (!root) return;
    const wanted = new Set();
    let count = 0,
      cursor = this.theme.nextElementSibling;
    const walk = (parent, depth) => {
      for (const element of parent.children) {
        if (count >= 400) return;
        if (!isSelectableElement(element, root)) continue;
        count++;
        wanted.add(element);
        let row = this.records.get(element);
        if (!row) {
          row = document.createElement('div');
          row.className = 'layer-row';
          row.role = 'listitem';
          row.innerHTML =
            '<button type="button" class="layer-select"></button><button type="button" class="layer-lock"></button>';
          row
            .querySelector('.layer-select')
            .addEventListener('click', () => canvas.select(element));
          row.querySelector('.layer-lock').addEventListener('click', () => {
            canvas.select(element);
            canvas.toggleLock();
            this.refresh();
          });
          this.records.set(element, row);
        }
        const name = label(element),
          lock = canvas.lockInfo(element);
        row.style.setProperty('--layer-depth', Math.min(12, depth));
        row.querySelector('.layer-select').textContent = name;
        row.querySelector('.layer-select').title = name;
        const button = row.querySelector('.layer-lock');
        button.textContent = lock.locked ? '🔒' : '○';
        button.title =
          lock.owner && lock.owner !== element
            ? 'Разблокировать родительскую группу'
            : lock.locked
              ? 'Разблокировать элемент'
              : 'Заблокировать элемент';
        button.setAttribute('aria-label', button.title + ' · ' + name);
        row.classList.toggle('layer-locked', lock.locked);
        if (row !== cursor) this.list.insertBefore(row, cursor);
        cursor = row.nextElementSibling;
        if (element.localName !== 'svg') walk(element, depth + 1);
      }
    };
    walk(root, 0);
    for (const [element, row] of this.records)
      if (!wanted.has(element)) {
        row.remove();
        this.records.delete(element);
      }
    this.parent.querySelector('.layers-limit').hidden = count < 400;
    this.root = root;
    this.firstChild = root.firstChild;
    this.syncSelection();
  }
  syncSelection() {
    const canvas = this.getCanvas();
    if (!canvas.root) return;
    if (this.root !== canvas.root || this.firstChild !== canvas.root.firstChild) {
      this.refresh();
      return;
    }
    const selected = this.records.get(canvas.selected);
    if (this.selectedRow !== selected) {
      this.selectedRow?.classList.remove('layer-selected');
      selected?.classList.add('layer-selected');
      this.selectedRow = selected;
    }
    this.theme.classList.toggle('layer-selected', !!canvas.selected && canvas.lockInfo().theme);
  }
}
