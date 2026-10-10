const maxFiles = 4,
  maxFileBytes = 8 * 1024 * 1024,
  maxTotalBytes = 20 * 1024 * 1024;
export const attachmentSize = (bytes) =>
  bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' МБ'
    : Math.max(1, Math.round(bytes / 1024)) + ' КБ';
const safePreview = (url, base) =>
  typeof url === 'string' && url.startsWith(base + '/attachments/') ? url : null;

export function renderMessageAttachments(container, attachments, base) {
  if (!attachments?.length) return;
  const list = document.createElement('div');
  list.className = 'message-attachments';
  for (const item of attachments) {
    const link = document.createElement('a');
    link.className = 'message-attachment';
    link.href = base + '/attachments/' + encodeURIComponent(item.id) + '/file';
    link.target = '_blank';
    link.rel = 'noopener';
    const preview = safePreview(item.previewUrl, base);
    if (item.kind === 'image' && preview) {
      const image = document.createElement('img');
      image.src = preview;
      image.alt = item.name;
      image.loading = 'lazy';
      link.append(image);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attachment-file-icon';
      icon.textContent = item.kind === 'text' ? '≡' : '▧';
      link.append(icon);
    }
    const text = document.createElement('span'),
      name = document.createElement('strong'),
      size = document.createElement('small');
    name.textContent = item.name;
    size.textContent = attachmentSize(item.size);
    text.append(name, size);
    link.append(text);
    list.append(link);
  }
  container.append(list);
}

export class ChatAttachments {
  constructor({ base, button, input, list, status, pasteTarget, onChange }) {
    Object.assign(this, { base, button, input, list, status, onChange });
    this.items = [];
    this.busy = false;
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      this.add(input.files);
      input.value = '';
    });
    pasteTarget.addEventListener('paste', (event) => {
      const files = [...event.clipboardData.items]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length) {
        event.preventDefault();
        this.add(files);
      }
    });
    this.render();
  }
  get blocked() {
    return this.items.some((item) => item.state !== 'ready');
  }
  get metadata() {
    return this.items.filter((item) => item.state === 'ready').map((item) => item.metadata);
  }
  setBusy(value) {
    this.busy = value;
    this.button.disabled = value;
    this.render();
  }
  add(files) {
    if (this.busy) return;
    this.status.textContent = '';
    for (const file of [...files]) {
      if (this.items.length >= maxFiles) {
        this.status.textContent = 'Можно прикрепить до 4 файлов. Лишние файлы не добавлены.';
        break;
      }
      const item = {
        localId: crypto.randomUUID(),
        file,
        name: file.name || 'Изображение.png',
        size: file.size,
        state: 'uploading',
        progress: 0,
      };
      this.items.push(item);
      const total = this.items.reduce((sum, value) => sum + value.size, 0);
      if (file.size > maxFileBytes || total > maxTotalBytes) {
        item.state = 'error';
        item.error =
          file.size > maxFileBytes ? 'Максимум 8 МБ на файл.' : 'Общий размер файлов — до 20 МБ.';
      } else {
        if (file.type.startsWith('image/')) item.localURL = URL.createObjectURL(file);
        this.upload(item);
      }
    }
    this.render();
  }
  async upload(item) {
    item.state = 'uploading';
    item.progress = 0;
    item.error = null;
    this.render();
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        item.reader = reader;
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            item.progress = Math.round((event.loaded / event.total) * 20);
            this.render();
          }
        };
        reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        reader.onabort = () => reject(new DOMException('Отменено', 'AbortError'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(item.file);
      });
      if (!this.items.includes(item)) return;
      const metadata = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        item.xhr = xhr;
        xhr.open('POST', this.base + '/attachments');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            item.progress = 20 + Math.round((event.loaded / event.total) * 75);
            this.render();
          }
        };
        xhr.onerror = () =>
          reject(new Error('Не удалось загрузить файл. Проверьте соединение и повторите.'));
        xhr.onabort = () => reject(new DOMException('Отменено', 'AbortError'));
        xhr.onload = () => {
          let result;
          try {
            result = JSON.parse(xhr.responseText);
          } catch {
            return reject(new Error('Сервер не принял файл.'));
          }
          if (xhr.status < 200 || xhr.status >= 300)
            return reject(new Error(result.error || 'Не удалось загрузить файл.'));
          resolve(result);
        };
        xhr.send(
          JSON.stringify({
            name: item.name,
            mime: item.file.type || 'application/octet-stream',
            data,
          }),
        );
      });
      if (!this.items.includes(item)) return;
      item.metadata = metadata;
      item.state = 'ready';
      item.progress = 100;
    } catch (error) {
      if (!this.items.includes(item)) return;
      item.state = 'error';
      item.error = error.message;
    } finally {
      delete item.reader;
      delete item.xhr;
    }
    this.render();
  }
  remove(item) {
    item.reader?.abort();
    item.xhr?.abort();
    if (item.localURL) URL.revokeObjectURL(item.localURL);
    this.items = this.items.filter((value) => value !== item);
    this.render();
  }
  clear() {
    for (const item of [...this.items]) this.remove(item);
    this.status.textContent = '';
  }
  render() {
    this.list.replaceChildren();
    this.list.hidden = !this.items.length;
    for (const item of this.items) {
      const card = document.createElement('div');
      card.className = 'attachment-chip ' + item.state;
      card.dataset.attachmentLocalId = item.localId;
      const preview = safePreview(item.metadata?.previewUrl, this.base) || item.localURL;
      if (preview) {
        const image = document.createElement('img');
        image.src = preview;
        image.alt = item.name;
        card.append(image);
      } else {
        const icon = document.createElement('span');
        icon.className = 'attachment-file-icon';
        icon.textContent = '▧';
        card.append(icon);
      }
      const text = document.createElement('div');
      text.className = 'attachment-chip-text';
      const name = document.createElement('strong');
      name.textContent = item.name;
      name.title = item.name;
      const state = document.createElement('small');
      state.textContent =
        item.state === 'error'
          ? item.error
          : item.state === 'uploading'
            ? 'Загрузка ' + item.progress + '%'
            : attachmentSize(item.size) +
              (item.metadata.kind === 'binary' ? ' · без распознавания' : ' · готово');
      text.append(name, state);
      card.append(text);
      if (item.state === 'uploading') {
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = item.progress;
        progress.setAttribute('aria-label', 'Загрузка ' + item.name);
        text.append(progress);
      }
      if (
        item.state === 'error' &&
        item.size <= maxFileBytes &&
        this.items.reduce((sum, value) => sum + value.size, 0) <= maxTotalBytes
      ) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'attachment-retry';
        retry.textContent = '↻';
        retry.title = 'Повторить загрузку';
        retry.setAttribute('aria-label', 'Повторить загрузку ' + item.name);
        retry.disabled = this.busy;
        retry.addEventListener('click', () => this.upload(item));
        card.append(retry);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = '×';
      remove.title = 'Убрать файл';
      remove.setAttribute('aria-label', 'Убрать ' + item.name);
      remove.disabled = this.busy;
      remove.addEventListener('click', () => this.remove(item));
      card.append(remove);
      this.list.append(card);
    }
    this.onChange?.();
  }
}
