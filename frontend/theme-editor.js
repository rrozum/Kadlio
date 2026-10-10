import { finishChatLoading } from './modules/chat-loading.js';
import { navigate } from './modules/navigation.js';
import { listen, pageTimeout } from './modules/page-lifecycle.js';
import { request, escapeHTML } from './modules/api.js';
import { ThemeCanvas } from './engine/theme-canvas.js';
import { themeTemplateSource } from '../shared/presentation/design.js';
import { blockModules } from './engine/blocks.js';
import { mountEditorAddons } from './addons/registry.js';
import { initTheme } from './modules/theme.js';
import { applyIcons } from './modules/icons.js';
import { SourceEditor } from './modules/source-editor.js';
import { ThemeChat } from './modules/theme-chat.js';
import { mountThemeTour } from './modules/theme-tour.js';
export async function mount(scope) {
  const document = scope.document;

  const $ = (id) => document.getElementById(id);
  const themeHTMLSource = new SourceEditor($('theme-source-html')),
    themeCSSSource = new SourceEditor($('theme-source-css'), { language: 'css' }),
    themeBaseSource = new SourceEditor($('theme-source-base-css'), { language: 'css' });
  initTheme($('theme-toggle'));
  applyIcons();
  let id = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1)),
    theme,
    design,
    source,
    baseline,
    dirty = false,
    saving = false,
    renderQueue = Promise.resolve(),
    renderScheduled = false,
    themeChat,
    toastTimer,
    saveError,
    restoringSelection = false,
    allowLeave = false;
  const tour = mountThemeTour({
    getState: () =>
      theme ? { themeId: id, dirty: hasUnsavedChanges(), busy: !!themeChat?.busy, saving } : null,
    onSave: async () => {
      if (canvas.transformState || canvas.root?.querySelector('[contenteditable=true]'))
        throw new Error('Завершите редактирование элемента на холсте.');
      if ($('theme-exit-dialog').open)
        throw new Error('Закройте подтверждение выхода перед сохранением.');
      if ($('theme-source-dialog').open) await applySource();
      if (dirty) await save();
      return theme;
    },
  });
  const history = { past: [], future: [] };
  const canvas = new ThemeCanvas({
    iframe: $('theme-canvas'),
    frame: $('theme-slide-frame'),
    space: $('theme-canvas-space'),
    selection: $('theme-selection'),
    callbacks: {
      onChange: (html) => {
        remember();
        source.html = html;
        design.template = { ...design.template, html, css: source.css };
        updateDirty();
      },
      onSelection: showObject,
      onReady: () => {
        $('theme-loading').hidden = true;
        scope.ready();
      },
      onScale: (scale) => {
        $('theme-zoom').textContent = Math.round(scale * 100) + '%';
      },
      onSave: () => save().catch(fail),
      onUndo: (redo) => undo(redo),
      onKey: handleKeys,
    },
  });
  mountEditorAddons(
    { getCanvas: () => canvas, onError: fail },
    {
      'design-elements': {
        button: $('theme-elements-tool'),
        getCanvas: () => canvas,
        getProject: () => ({ id: 'theme', design, css: design?.sourceCSS || '', slides: [] }),
        onInsert: (html) => {
          const fragment = canvas.doc.createElement('template');
          fragment.innerHTML = html;
          canvas.insert(fragment.content.firstElementChild);
        },
        onError: fail,
      },
    },
  );
  function fail(error) {
    $('theme-toast').textContent = error.message || String(error);
    $('theme-toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = pageTimeout(() => ($('theme-toast').hidden = true), 7000);
  }
  function snapshot() {
    return JSON.stringify({ design, source, title: $('theme-name').value });
  }
  function updateDirty() {
    dirty = snapshot() !== baseline;
    $('theme-save-status').textContent = saveError || (dirty ? 'Есть изменения' : 'Сохранено');
    $('theme-save-status').classList.toggle('error', !!saveError);
    $('theme-save-status').classList.toggle('dirty', dirty);
    $('theme-save').disabled = saving || themeChat?.busy || (!theme.builtin && !dirty);
    $('theme-copy').disabled = saving || themeChat?.busy;
    $('theme-undo').disabled = !history.past.length;
    $('theme-redo').disabled = !history.future.length;
    tour.notify();
  }
  function remember() {
    saveError = null;
    if (!design) return;
    history.past.push(snapshot());
    if (history.past.length > 50) history.past.shift();
    history.future = [];
  }
  // Объединяем быстрые правки в один кадр и сохраняем выбранный блок после рендера шаблона.
  function rendering() {
    if (renderScheduled) return renderQueue;
    renderScheduled = true;
    const work = renderQueue
      .catch(() => {})
      .then(() => new Promise(requestAnimationFrame))
      .then(async () => {
        renderScheduled = false;
        const selected = canvas.selected?.dataset.blockId;
        await canvas.renderTemplate(source, design);
        if (selected) {
          restoringSelection = true;
          try {
            canvas.select(
              [...canvas.root.querySelectorAll('[data-block-id]')].find(
                (element) => element.dataset.blockId === selected,
              ) || null,
            );
          } finally {
            restoringSelection = false;
          }
        }
      });
    renderQueue = work;
    return work;
  }
  function adopt(value) {
    theme = value;
    id = theme.id;
    design = structuredClone(theme.design);
    source = themeTemplateSource(design);
    $('theme-name').value = theme.title;
    document.title = theme.title + ' · Тема · Kadlio';
    $('theme-save').textContent = theme.builtin ? 'Сохранить копию' : 'Сохранить';
    baseline = snapshot();
    dirty = false;
    renderAppearance();
    updateDirty();
    themeChat?.sync().catch(fail);
  }
  // Тема хранится отдельно: CAS обновляет только её запись, а встроенная тема сохраняется копией.
  async function save(copy = false, { forChat = false } = {}) {
    if (tour.enabled && (copy || theme.builtin))
      throw new Error('В туре редактируется только выбранная собственная тема.');
    if (themeChat?.busy && !forChat)
      throw new Error('Дождитесь ответа агента или остановите его перед сохранением темы.');
    if (saving) return;
    saving = true;
    saveError = null;
    $('theme-save').disabled = true;
    $('theme-save-status').textContent = 'Сохраняем…';
    tour.notify();
    try {
      await renderQueue;
      const title = $('theme-name').value.trim();
      if (!title) throw new Error('Укажите название темы.');
      design.template = { ...design.template, html: source.html, css: source.css };
      design.decorations = [];
      let saved;
      if (copy || theme.builtin) {
        const created = await request('/api/themes', {
          method: 'POST',
          body: { title: copy ? title + ' — копия' : title, baseThemeId: theme.id },
        });
        const from = '/api/themes/' + theme.id + '/assets/',
          to = '/api/themes/' + created.id + '/assets/';
        const copied = JSON.parse(JSON.stringify(design).split(from).join(to));
        saved = await request('/api/themes/' + encodeURIComponent(created.id), {
          method: 'PATCH',
          body: { design: copied, version: created.version },
        });
      } else
        saved = await request('/api/themes/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: { title, design, version: theme.version },
        });
      history.past = [];
      history.future = [];
      adopt(saved);
      window.history.replaceState(
        window.history.state,
        '',
        '/themes/' + encodeURIComponent(id) + (tour.enabled ? '?embed=tour' : ''),
      );
      globalThis.document.dispatchEvent(new Event('kadlio:route-replaced'));
      await rendering();
    } catch (error) {
      saveError = error.status === 409 ? 'Конфликт изменений' : 'Не сохранено';
      $('theme-save-status').textContent = saveError;
      $('theme-save-status').classList.add('error');
      if (error.status === 409)
        error.message = tour.enabled
          ? 'Тему изменили в другом окне. Ваши изменения остались в редакторе. Согласуйте их с актуальной версией перед сохранением.'
          : 'Тему изменили в другом окне. Ваши изменения остались на холсте и в HTML/CSS; сохраните их копией или согласуйте после обновления.';
      throw error;
    } finally {
      saving = false;
      updateDirty();
    }
  }
  async function undo(redo = false) {
    const from = redo ? history.future : history.past,
      to = redo ? history.past : history.future;
    if (!from.length) return;
    to.push(snapshot());
    const saved = JSON.parse(from.pop());
    design = saved.design;
    source = saved.source;
    $('theme-name').value = saved.title;
    renderAppearance();
    updateDirty();
    await rendering();
  }
  function setPanel(name) {
    for (const panel of ['object', 'appearance'])
      $('theme-' + panel + '-panel').hidden = panel !== name;
    document
      .querySelectorAll('[data-theme-tab]')
      .forEach((button) =>
        button.setAttribute('aria-selected', String(button.dataset.themeTab === name)),
      );
  }
  function showObject(properties) {
    $('theme-selection-empty').hidden = !!properties;
    $('theme-object-form').hidden = !properties;
    if (!properties) return;
    if (!restoringSelection) setPanel('object');
    $('theme-object-type').textContent =
      { text: 'Текст', image: 'Изображение', preset: 'Композиция', element: 'Элемент' }[
        properties.type
      ] || 'Элемент';
    $('theme-element-properties').hidden = properties.type !== 'element';
    $('theme-element-color').value = properties.color;
    const text = properties.type === 'text';
    $('theme-text-properties').hidden = !text;
    for (const key of [
      'text',
      'fontSize',
      'color',
      'background',
      'borderWidth',
      'borderColor',
      'radius',
      'opacity',
    ]) {
      const input = $('theme-prop-' + key);
      if (input && document.activeElement !== input) input.value = properties[key];
    }
    $('theme-bold').setAttribute('aria-pressed', String(properties.bold));
    $('theme-italic').setAttribute('aria-pressed', String(properties.italic));
    document
      .querySelectorAll('[data-theme-align]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.themeAlign === properties.align)),
      );
  }
  function renderAppearance() {
    $('theme-colors').innerHTML = Object.entries({
      background: 'Фон',
      text: 'Текст',
      muted: 'Подписи',
      accent: 'Акцент',
      surface: 'Карточки',
      border: 'Обводки',
    })
      .map(
        ([key, label]) =>
          '<label>' +
          label +
          '<input type="color" data-theme-token="' +
          key +
          '" value="' +
          escapeHTML(design.tokens[key]) +
          '"></label>',
      )
      .join('');
    $('theme-font').value = design.tokens.font;
    $('theme-background-type').value = design.background.type;
    $('theme-gradient').value =
      design.background.type === 'gradient'
        ? design.background.value
        : 'linear-gradient(135deg, ' +
          design.tokens.background +
          ', ' +
          design.tokens.surface +
          ')';
    $('theme-author').value = design.metadata.author;
    $('theme-brand').value = design.metadata.brand;
    showBackground();
  }
  function showBackground() {
    $('theme-gradient-label').hidden = design.background.type !== 'gradient';
    $('theme-background-image-label').hidden = design.background.type !== 'image';
  }
  function appearanceChanged(event) {
    remember();
    for (const input of document.querySelectorAll('[data-theme-token]'))
      design.tokens[input.dataset.themeToken] = input.value;
    design.tokens.font = $('theme-font').value;
    design.metadata.author = $('theme-author').value;
    design.metadata.brand = $('theme-brand').value;
    const type = $('theme-background-type').value;
    design.background = {
      type,
      value:
        type === 'solid'
          ? design.tokens.background
          : type === 'gradient'
            ? $('theme-gradient').value
            : design.background.type === 'image'
              ? design.background.value
              : '',
    };
    showBackground();
    legacyAppearance(event?.target);
    updateDirty();
    rendering().catch(fail);
  }
  function legacyAppearance(input, background = false) {
    if (!design.sourceCSS) return;
    const marker = /\/\* studio-appearance \*\/\s*\.slide\{([^}]*)\}/;
    const existing = design.sourceCSS.match(marker),
      values = {};
    for (const item of (existing?.[1] || '').split(';')) {
      const split = item.indexOf(':');
      if (split > 0) values[item.slice(0, split)] = item.slice(split + 1);
    }
    if (input?.dataset.themeToken || input?.id === 'theme-font')
      Object.assign(values, {
        '--ink': 'var(--pres-text)',
        '--muted': 'var(--pres-muted)',
        '--blue': 'var(--pres-accent)',
        color: 'var(--pres-text)',
        'font-family': 'var(--pres-font)',
      });
    if (
      background ||
      input?.dataset.themeToken === 'background' ||
      ['theme-background-type', 'theme-gradient'].includes(input?.id)
    ) {
      const b = design.background;
      values.background =
        (b.type === 'image'
          ? 'url("' + b.value + '") ' + design.tokens.background
          : b.type === 'gradient'
            ? b.value + ' ' + design.tokens.background
            : b.value) + '!important';
      values['background-size'] = 'cover!important';
      values['background-position'] = 'center!important';
    }
    if (Object.keys(values).length)
      design.sourceCSS =
        design.sourceCSS.replace(marker, '') +
        '\n/* studio-appearance */.slide{' +
        Object.entries(values)
          .map(([key, value]) => key + ':' + value)
          .join(';') +
        '}';
  }
  async function upload(file) {
    if (
      !file ||
      file.size > 8 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
    )
      throw new Error('Выберите PNG, JPEG, WebP или GIF до 8 МБ.');
    if (theme.builtin) await save(true);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return request('/api/themes/' + encodeURIComponent(id) + '/assets', {
      method: 'POST',
      body: { name: file.name, mime: file.type, data },
    });
  }
  function addText(value = 'Новый текст') {
    const element = blockModules.get('text').create(canvas.doc, { text: value });
    element.style.color = 'var(--pres-text)';
    canvas.insert(element);
  }
  $('theme-text-tool').addEventListener('click', () => addText());
  $('theme-fit').addEventListener('click', () => canvas.fit());
  $('theme-save').addEventListener('click', () => save().catch(fail));
  $('theme-copy').addEventListener('click', () => save(true).catch(fail));
  $('theme-name').addEventListener('input', () => {
    saveError = null;
    updateDirty();
  });
  $('theme-undo').addEventListener('click', () => undo().catch(fail));
  $('theme-redo').addEventListener('click', () => undo(true).catch(fail));
  document
    .querySelectorAll('[data-theme-tab]')
    .forEach((button) => button.addEventListener('click', () => setPanel(button.dataset.themeTab)));
  $('theme-properties-toggle').addEventListener('click', () =>
    $('theme-properties').classList.toggle('mobile-open'),
  );
  for (const key of [
    'text',
    'fontSize',
    'color',
    'background',
    'borderWidth',
    'borderColor',
    'radius',
    'opacity',
  ])
    $('theme-prop-' + key).addEventListener('input', (event) =>
      canvas.setProperty(key, event.target.value),
    );
  $('theme-element-color').addEventListener('input', (event) =>
    canvas.setProperty('color', event.target.value),
  );
  $('theme-bold').addEventListener('click', () =>
    canvas.setProperty('bold', $('theme-bold').getAttribute('aria-pressed') !== 'true'),
  );
  $('theme-italic').addEventListener('click', () =>
    canvas.setProperty('italic', $('theme-italic').getAttribute('aria-pressed') !== 'true'),
  );
  document
    .querySelectorAll('[data-theme-align]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        canvas.setProperty('align', button.dataset.themeAlign),
      ),
    );
  $('theme-transparent').addEventListener('click', () =>
    canvas.setProperty('background', 'transparent'),
  );
  $('theme-delete-object').addEventListener('click', () => canvas.remove());
  $('theme-duplicate-object').addEventListener('click', () => canvas.duplicate());
  $('theme-object-form').addEventListener('submit', (event) => event.preventDefault());
  $('theme-appearance-form').addEventListener('submit', (event) => event.preventDefault());
  $('theme-appearance-form').addEventListener('input', (event) => {
    if (event.target.type !== 'file') appearanceChanged(event);
  });
  $('theme-background-type').addEventListener('change', appearanceChanged);
  $('theme-background-file').addEventListener('change', async (event) => {
    try {
      const result = await upload(event.target.files[0]);
      remember();
      design.background = { type: 'image', value: result.url };
      legacyAppearance(null, true);
      updateDirty();
      await rendering();
    } catch (error) {
      fail(error);
    }
  });
  $('theme-image-tool').addEventListener('click', () => {
    $('theme-image-status').textContent = '';
    $('theme-image-file').value = '';
    $('theme-image-dialog').showModal();
  });
  $('theme-image-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const result = await upload($('theme-image-file').files[0]);
      canvas.insert(
        blockModules
          .get('image')
          .create(canvas.doc, { src: result.url, alt: $('theme-image-alt').value }),
      );
      $('theme-image-dialog').close();
    } catch (error) {
      $('theme-image-status').textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });
  $('theme-source').addEventListener('click', () => {
    $('theme-base-source').hidden = !design.sourceCSS;
    $('theme-source-dialog').showModal();
    Promise.all([
      themeHTMLSource.setValue(source.html),
      themeCSSSource.setValue(source.css),
      themeBaseSource.setValue(design.sourceCSS || ''),
    ])
      .then(() => tour.notify())
      .catch(fail);
  });
  async function applySource() {
    const next = { html: themeHTMLSource.getValue(), css: themeCSSSource.getValue() },
      baseCSS = themeBaseSource.getValue();
    if (
      next.html === source.html &&
      next.css === source.css &&
      baseCSS === (design.sourceCSS || '')
    ) {
      $('theme-source-dialog').close();
      return;
    }
    remember();
    source = next;
    design.template = { ...design.template, ...source };
    if (design.sourceCSS !== undefined) design.sourceCSS = baseCSS;
    updateDirty();
    await rendering();
    $('theme-source-dialog').close();
  }
  $('theme-source-form').addEventListener('submit', (event) => {
    event.preventDefault();
    applySource().catch(fail);
  });
  for (const editor of [themeHTMLSource, themeCSSSource, themeBaseSource])
    editor.textarea.addEventListener('input', () => tour.notify());
  $('theme-source-dialog').addEventListener('close', () => tour.notify());
  const variables = {
    author: 'Автор',
    brand: 'Подпись / проект',
    projectTitle: 'Название презентации',
    slideTitle: 'Название слайда',
    section: 'Раздел',
    slideNumber: 'Номер слайда',
    slideCount: 'Всего слайдов',
  };
  for (const [key, label] of Object.entries(variables)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = escapeHTML(label) + '<code>{{' + key + '}}</code>';
    button.addEventListener('click', () => {
      addText('{{' + key + '}}');
      $('theme-variables-dialog').close();
    });
    $('theme-variable-list').append(button);
  }
  $('theme-variable-tool').addEventListener('click', () => $('theme-variables-dialog').showModal());
  document
    .querySelectorAll('[data-close]')
    .forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  function handleKeys(event) {
    if (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
      event.target.isContentEditable ||
      document.querySelector('dialog[open]')
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save().catch(fail);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo(event.shiftKey).catch(fail);
    }
  }
  listen(document, 'keydown', (event) => {
    if ($('theme-exit-dialog').open) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')
        event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if ($('theme-source-dialog').open) $('theme-source-form').requestSubmit();
      else save().catch(fail);
    } else handleKeys(event);
  });
  function hasUnsavedChanges() {
    return (
      dirty ||
      ($('theme-source-dialog').open &&
        [themeHTMLSource, themeCSSSource, themeBaseSource].some((editor) => editor.dirty))
    );
  }
  function leave() {
    allowLeave = true;
    navigate('/themes');
  }
  document.querySelectorAll('[data-theme-exit]').forEach((control) =>
    control.addEventListener('click', (event) => {
      if (tour.enabled) {
        event.preventDefault();
        return;
      }
      if (
        control.tagName === 'A' &&
        (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
      )
        return;
      event.preventDefault();
      if (hasUnsavedChanges()) $('theme-exit-dialog').showModal();
      else leave();
    }),
  );
  $('theme-exit-continue').addEventListener('click', () => $('theme-exit-dialog').close());
  $('theme-exit-discard').addEventListener('click', leave);
  listen(window, 'pageshow', () => {
    allowLeave = false;
  });
  listen(window, 'beforeunload', (event) => {
    if (!allowLeave && hasUnsavedChanges()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  async function prepareThemeChat() {
    if (saving) throw new Error('Дождитесь сохранения темы.');
    if (theme.builtin) await save(true, { forChat: true });
    else if (dirty) await save(false, { forChat: true });
  }
  async function showAgentChanges() {
    const saved = await request('/api/themes/' + encodeURIComponent(id));
    if (saved.version === theme.version) return;
    if (hasUnsavedChanges() || canvas.transformState || document.querySelector('dialog[open]')) {
      fail(
        new Error(
          'Агент обновил тему. Ваш черновик оставлен на холсте; сохраните его копией или обновите страницу, чтобы показать правки агента.',
        ),
      );
      return;
    }
    remember();
    adopt(saved);
    await rendering();
  }
  try {
    const loaded = await request('/api/themes/' + encodeURIComponent(id));
    if (tour.enabled && loaded.builtin)
      throw new Error('Создайте собственную тему перед открытием редактора в туре.');
    adopt(loaded);
    await rendering();
    themeChat = new ThemeChat({
      getTheme: () => theme,
      prepare: prepareThemeChat,
      onSaved: showAgentChanges,
      onError: fail,
      onBusy: updateDirty,
    });
    await themeChat.init();
    tour.notify();
  } catch (error) {
    finishChatLoading(document, error);
    if (!theme) $('theme-loading').textContent = error.message;
    fail(error);
  }
}
