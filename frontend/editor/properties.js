import { pageScope } from '../modules/page-lifecycle.js';
import { request } from '../modules/api.js';
import { blockModules, isSelectableElement } from '../engine/blocks.js';
export function createEditorProperties({
  base,
  canvas,
  layersUI,
  setTab,
  setTool,
  flush: flushAll,
  openThemeEditor,
  showDialog,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  let imageReplacing = false,
    imagePlaceholder = null;
  function showProperties(properties, { passive = false } = {}) {
    layersUI.syncSelection();
    $('selection-empty').hidden = !!properties;
    $('block-properties').hidden = !properties;
    if (!properties) return;
    if (!passive) setTab('properties');
    $('block-type').textContent =
      {
        image: 'Изображение',
        preset: 'Композиция',
        element: 'Элемент',
        text: 'Текст',
        group: 'Группа',
        shape: 'Фигура',
        icon: 'Иконка',
        video: 'Видео',
        theme: 'Тема',
      }[properties.type] || 'Элемент';
    $('text-properties').hidden = properties.type !== 'text';
    $('image-properties').hidden = properties.type !== 'image';
    $('element-properties').hidden = !['element', 'icon', 'shape'].includes(properties.type);
    $('prop-element-color').value = properties.color;
    const locked = properties.locked;
    $('lock-block').disabled = properties.type === 'theme';
    $('lock-block').textContent = locked ? '🔒' : '○';
    $('lock-block').title = properties.inheritedLock
      ? 'Разблокировать родительскую группу'
      : locked
        ? 'Разблокировать элемент'
        : 'Заблокировать элемент';
    $('lock-block').setAttribute('aria-label', $('lock-block').title);
    $('property-lock-status').textContent =
      properties.type === 'theme'
        ? 'Общий шаблон защищён. Измените копию в редакторе тем, затем примените её к презентации.'
        : properties.inheritedLock
          ? 'Элемент защищён замком родительской группы.'
          : locked
            ? 'Элемент заблокирован. Снимите замок, чтобы изменить его.'
            : '';
    $('edit-theme-layer').hidden = properties.type !== 'theme';
    $('block-properties')
      .querySelectorAll('fieldset')
      .forEach((fieldset) => (fieldset.disabled = locked));
    $('delete-block').disabled = locked;
    $('duplicate-block').disabled = locked;
    const parent = canvas.selected?.parentElement;
    $('select-parent').disabled = !isSelectableElement(parent, canvas.root);
    const values = {
      x: properties.x,
      y: properties.y,
      width: properties.width,
      height: properties.height,
      text: properties.text,
      alt: properties.alt,
      'font-size': Math.round(properties.fontSize),
      color: properties.color,
      background: properties.background,
      'border-width': properties.borderWidth,
      'border-color': properties.borderColor,
      radius: properties.radius,
      opacity: properties.opacity,
      fit: properties.fit,
    };
    for (const [id, value] of Object.entries(values)) {
      const input = $('prop-' + id);
      if (input && document.activeElement !== input) input.value = value;
    }
    $('prop-bold').setAttribute('aria-pressed', String(properties.bold));
    $('prop-italic').setAttribute('aria-pressed', String(properties.italic));
    $('prop-transparent').textContent = properties.transparent ? 'Без фона ✓' : 'Без фона';
    document
      .querySelectorAll('[data-align]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.align === properties.align)),
      );
  }
  const propertyNames = {
    x: 'x',
    y: 'y',
    width: 'width',
    height: 'height',
    text: 'text',
    alt: 'alt',
    'font-size': 'fontSize',
    color: 'color',
    background: 'background',
    'border-width': 'borderWidth',
    'border-color': 'borderColor',
    radius: 'radius',
    opacity: 'opacity',
    fit: 'fit',
  };
  for (const [id, name] of Object.entries(propertyNames))
    $('prop-' + id).addEventListener(id === 'text' ? 'input' : 'change', (event) =>
      canvas.setProperty(name, event.target.value),
    );
  $('prop-bold').addEventListener('click', () =>
    canvas.setProperty('bold', $('prop-bold').getAttribute('aria-pressed') !== 'true'),
  );
  $('prop-italic').addEventListener('click', () =>
    canvas.setProperty('italic', $('prop-italic').getAttribute('aria-pressed') !== 'true'),
  );
  document
    .querySelectorAll('[data-align]')
    .forEach((button) =>
      button.addEventListener('click', () => canvas.setProperty('align', button.dataset.align)),
    );
  $('prop-transparent').addEventListener('click', () =>
    canvas.setProperty('background', 'transparent'),
  );
  $('lock-block').addEventListener('click', () => {
    canvas.toggleLock();
    layersUI.refresh();
  });
  $('select-parent').addEventListener('click', () => canvas.select(canvas.selected.parentElement));
  $('edit-theme-layer').addEventListener('click', openThemeEditor);
  $('delete-block').addEventListener('click', () => canvas.remove());
  $('duplicate-block').addEventListener('click', () => canvas.duplicate());
  $('prop-element-color').addEventListener('input', (event) =>
    canvas.setProperty('color', event.target.value),
  );
  $('block-properties').addEventListener('submit', (event) => event.preventDefault());
  function addBlock(id) {
    if (id === 'image') {
      openImage(false);
      return;
    }
    const module = blockModules.get(id);
    if (!module) return;
    setTool('select');
    canvas.insert(module.create(canvas.doc));
    setTab('properties');
  }
  $('text-tool').addEventListener('click', () => addBlock('text'));
  $('image-tool').addEventListener('click', () => openImage(false));
  document
    .querySelectorAll('[data-module]')
    .forEach((button) => button.addEventListener('click', () => addBlock(button.dataset.module)));
  function openImage(replace, placeholder = null) {
    imageReplacing = replace;
    imagePlaceholder = placeholder;
    $('image-status').textContent = '';
    $('image-file').value = '';
    $('image-alt').value = replace ? canvas.selected?.alt || '' : '';
    $('image-form').querySelector('button[type=submit]').textContent = replace
      ? 'Заменить'
      : 'Добавить';
    showDialog('image-dialog');
  }
  $('replace-image').addEventListener('click', () => openImage(true));
  $('image-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    $('image-status').classList.remove('error');
    $('image-status').textContent = 'Добавляем…';
    try {
      await flushAll();
      const file = $('image-file').files[0];
      if (!file) throw new Error('Выберите изображение');
      if (file.size > 8 * 1024 * 1024) throw new Error('Выберите изображение до 8 МБ');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
        throw new Error('Поддерживаются PNG, JPEG, WebP и GIF');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(file);
      });
      const result = await request(base + '/assets', {
        method: 'POST',
        body: { name: file.name, mime: file.type, data },
      });
      const options = { src: result.url, alt: $('image-alt').value };
      if (imagePlaceholder?.isConnected) {
        const image = blockModules.get('image').create(canvas.doc, options);
        const group = imagePlaceholder.closest('[data-block-type="preset"]');
        image.dataset.blockId = group.dataset.blockId + '-image';
        image.dataset.presetField = 'image';
        Object.assign(image.style, {
          position: 'static',
          width: '100%',
          height: '100%',
          display: 'block',
          left: '',
          top: '',
        });
        imagePlaceholder.replaceWith(image);
        canvas.select(image);
        canvas.changed();
        imagePlaceholder = null;
      } else if (imageReplacing) canvas.replaceImage(options);
      else canvas.insert(blockModules.get('image').create(canvas.doc, options));
      $('image-dialog').close();
      setTool('select');
      setTab('properties');
    } catch (error) {
      $('image-status').classList.add('error');
      $('image-status').textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });

  return { show: showProperties, openImage };
}
