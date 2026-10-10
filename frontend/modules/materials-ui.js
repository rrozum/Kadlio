import { request } from './api.js';
import { attachmentSize } from './chat-attachments.js';
import { icon } from './icons.js';

const defaultLimits = { fileBytes: 8 * 1024 * 1024, count: 50, totalBytes: 100 * 1024 * 1024 };
const statusText = (item) =>
  (({
    ready: 'Доступен агенту',
    no_text: 'Сохранён · текст не найден',
    unsupported_format: 'Сохранён · формат без распознавания',
    unsupported_encoding: 'Сохранён · текст не распознан',
    unreadable_document: 'Сохранён · не удалось прочитать текст',
    unreadable_image: 'Сохранён · не удалось прочитать изображение',
  })[item.status] ||
    (item.kind === 'binary' ? 'Сохранён · формат без распознавания' : 'Доступен агенту')) +
  (item.truncated ? ' · текст сокращён' : '');

// Тур и редактор используют один список материалов проекта. Загружаем файлы
// последовательно, чтобы большие документы не занимали память одновременно.
export class MaterialsUI {
  constructor({ base, input, drop, list, status, button, onChange = () => {} }) {
    Object.assign(this, { base, input, drop, list, status, button, onChange });
    this.materials = [];
    this.pending = [];
    this.limits = defaultLimits;
    this.locked = false;
    this.rows = new Map();
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      this.add(input.files);
      input.value = '';
    });
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!this.locked) drop.classList.add('drag-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('drag-over');
      this.add(event.dataTransfer.files);
    });
  }
  get blocked() {
    return this.pending.length > 0;
  }
  get uploading() {
    return this.pending.some((item) => item.state === 'uploading' || item.state === 'queued');
  }
  async load() {
    const result = await request(this.base + '/materials');
    this.materials = result.materials;
    this.limits = result.limits || defaultLimits;
    this.render();
  }
  setLocked(value) {
    this.locked = value;
    this.button.disabled = value;
    this.render();
  }
  add(files) {
    if (this.locked) return;
    this.status.textContent = '';
    for (const file of [...files]) {
      const count = this.materials.length + this.pending.length,
        total =
          this.materials.reduce((sum, m) => sum + m.size, 0) +
          this.pending.reduce((sum, m) => sum + m.file.size, 0) +
          file.size;
      if (count >= this.limits.count) {
        this.status.textContent = 'Можно добавить до ' + this.limits.count + ' файлов.';
        break;
      }
      const item = { id: crypto.randomUUID(), file, state: 'queued', progress: 0 };
      if (!file.size || file.size > this.limits.fileBytes || total > this.limits.totalBytes) {
        item.state = 'error';
        item.error = !file.size
          ? 'Файл пуст.'
          : file.size > this.limits.fileBytes
            ? 'Максимум ' + attachmentSize(this.limits.fileBytes) + ' на файл.'
            : 'Суммарно можно загрузить ' + attachmentSize(this.limits.totalBytes) + '.';
      }
      this.pending.push(item);
    }
    this.render();
    this.pump();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let item; (item = this.pending.find((entry) => entry.state === 'queued'));) {
        item.state = 'uploading';
        this.render();
        try {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
            reader.readAsDataURL(item.file);
          });
          const saved = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', this.base + '/materials');
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.withCredentials = true;
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                item.progress = Math.round((event.loaded / event.total) * 95);
                this.render();
              }
            };
            xhr.onerror = () => reject(new Error('Не удалось загрузить. Проверьте соединение.'));
            xhr.onload = () => {
              let result;
              try {
                result = JSON.parse(xhr.responseText);
              } catch {
                return reject(new Error('Сервер не принял файл.'));
              }
              if (xhr.status < 200 || xhr.status >= 300) {
                const error = new Error(result.error || 'Ошибка загрузки');
                error.status = xhr.status;
                return reject(error);
              }
              resolve(result);
            };
            xhr.send(
              JSON.stringify({
                name: item.file.name,
                mime: item.file.type || 'application/octet-stream',
                data,
              }),
            );
          });
          this.materials.push(saved);
          this.pending = this.pending.filter((entry) => entry !== item);
        } catch (error) {
          item.state = 'error';
          item.error = error.message;
        }
        this.render();
      }
    } finally {
      this.running = false;
      this.render();
    }
  }
  async remove(item) {
    if (this.locked) return;
    if (this.pending.includes(item)) {
      if (item.state === 'uploading') return;
      this.pending = this.pending.filter((entry) => entry !== item);
      this.render();
      return;
    }
    try {
      await request(this.base + '/materials/' + encodeURIComponent(item.id), { method: 'DELETE' });
      this.materials = this.materials.filter((entry) => entry.id !== item.id);
      this.render();
    } catch (error) {
      this.status.textContent = error.message;
    }
  }
  render() {
    const items = [...this.materials, ...this.pending],
      ids = new Set(items.map((item) => item.id));
    for (const [id, entry] of this.rows)
      if (!ids.has(id)) {
        entry.row.remove();
        this.rows.delete(id);
      }
    let cursor = this.list.firstElementChild;
    for (const item of items) {
      const key = JSON.stringify([
        item.state,
        item.progress,
        item.error,
        item.status,
        item.truncated,
        this.locked,
      ]);
      const cached = this.rows.get(item.id);
      if (cached?.key === key) {
        if (cached.row !== cursor) this.list.insertBefore(cached.row, cursor);
        cursor = cached.row.nextElementSibling;
        continue;
      }

      const pending = this.pending.includes(item),
        name = pending ? item.file.name : item.name,
        row = document.createElement('div');
      row.className = pending ? 'material-card material-upload ' + item.state : 'material-card';
      row.dataset.materialId = item.id;
      const preview =
        !pending && item.kind === 'image' && item.previewUrl?.startsWith(this.base + '/materials/')
          ? item.previewUrl
          : null;
      if (preview) {
        const image = document.createElement('img');
        image.src = preview;
        image.alt = name;
        image.loading = 'lazy';
        row.append(image);
      } else {
        const pictogram = document.createElement('span');
        pictogram.className = 'material-icon';
        pictogram.innerHTML = icon('attachment');
        row.append(pictogram);
      }
      const text = document.createElement('div');
      text.className = 'material-info';
      const title = document.createElement(pending ? 'strong' : 'a');
      title.textContent = name;
      if (!pending) {
        title.href = this.base + '/materials/' + encodeURIComponent(item.id) + '/file';
        title.target = '_blank';
        title.rel = 'noopener';
      }
      const state = document.createElement('small');
      state.className = 'material-status';
      state.textContent = pending
        ? item.state === 'error'
          ? item.error
          : item.state === 'queued'
            ? 'В очереди'
            : 'Загрузка ' + item.progress + '%'
        : attachmentSize(item.size) + ' · ' + statusText(item);
      text.append(title, state);
      if (pending && item.state === 'uploading') {
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = item.progress;
        progress.setAttribute('aria-label', 'Загрузка ' + name);
        text.append(progress);
      }
      row.append(text);
      if (pending && item.state === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'material-retry';
        retry.textContent = 'Повторить';
        retry.disabled = this.locked || item.file.size > this.limits.fileBytes || !item.file.size;
        retry.addEventListener('click', () => {
          item.state = 'queued';
          this.render();
          this.pump();
        });
        row.append(retry);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'material-remove icon-button';
      remove.innerHTML = icon('close');
      remove.setAttribute('aria-label', 'Убрать ' + name);
      remove.disabled = this.locked || (pending && ['uploading', 'queued'].includes(item.state));
      remove.addEventListener('click', () => this.remove(item));
      row.append(remove);
      if (cached) {
        if (cursor === cached.row) cursor = cached.row.nextElementSibling;
        cached.row.replaceWith(row);
      } else this.list.insertBefore(row, cursor);
      this.rows.set(item.id, { key, row });
      cursor = row.nextElementSibling;
    }
    this.onChange(this);
  }
}
