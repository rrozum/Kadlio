import { navigate } from './modules/navigation.js';
import { listen, pageTimeout, pageInterval, onPageCleanup } from './modules/page-lifecycle.js';
import { request } from './modules/api.js';
import { initTheme } from './modules/theme.js';
import { mountThemePreview } from './modules/theme-preview.js';
import { MaterialsUI } from './modules/materials-ui.js';
import { icon } from './modules/icons.js';
export async function mount(scope) {
  const document = scope.document;

  const $ = (id) => document.getElementById(id),
    draftKey = 'presentations.creation-draft';
  const fresh = () => ({
    title: '',
    description: '',
    mode: 'smart',
    themeId: 'light',
    customThemeId: null,
    projectId: null,
    step: 'details',
    custom: false,
  });
  let draft = fresh(),
    themes = [],
    project,
    materials,
    themeState = {},
    themeReady,
    themeReadyResolve,
    themeNeedsApply = false,
    busy = true,
    generating = false,
    abort,
    timer,
    pollTimer,
    allowLeave = false,
    themePreviews = [];
  const themeRequests = new Map();
  onPageCleanup(() => abort?.abort());
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey));
    if (saved && typeof saved === 'object') draft = { ...draft, ...saved };
  } catch {}
  const duration = (ms) => {
    const n = Math.max(0, Math.floor(ms / 1000));
    return n < 60 ? n + ' сек.' : Math.floor(n / 60) + ' мин. ' + (n % 60) + ' сек.';
  };
  initTheme($('theme-toggle'));
  $('tour-brand-icon')?.replaceChildren();
  document.querySelector('.tour-brand-icon').innerHTML = icon('slides');
  function stash() {
    sessionStorage.setItem(draftKey, JSON.stringify(draft));
  }
  function problem(error) {
    $('tour-status').textContent = error.message || String(error);
    $('tour-status').classList.add('error');
  }
  function steps() {
    return [
      'details',
      'themes',
      ...(draft.custom ? ['theme-create'] : []),
      'materials',
      ...(draft.mode === 'smart' ? ['result'] : []),
    ];
  }
  function controls() {
    const sequence = steps(),
      index = sequence.indexOf(draft.step),
      result = draft.step === 'result';
    $('tour-back').disabled = busy || generating || index === 0 || result;
    $('tour-next').disabled =
      busy ||
      (draft.step === 'materials' && materials?.blocked) ||
      (draft.step === 'theme-create' &&
        (themeState.busy || themeState.saving || !themeState.themeId));
    $('tour-next').textContent = busy
      ? 'Подождите…'
      : draft.step === 'materials'
        ? draft.mode === 'smart'
          ? 'Создать с ИИ ✦'
          : 'Открыть пустую →'
        : 'Далее →';
    document.querySelector('.tour-footer').classList.toggle('generation-footer', result);
  }
  function progress() {
    const sequence = steps(),
      index = sequence.indexOf(draft.step),
      labels = {
        details: 'Идея',
        themes: 'Тема',
        'theme-create': 'Создание',
        materials: 'Материалы',
        result: 'Слайды',
      };
    const nav = $('tour-progress');
    nav.replaceChildren();
    for (const [i, id] of sequence.entries()) {
      const item = document.createElement('span');
      item.className = 'tour-progress-item ' + (i === index ? 'active' : i < index ? 'done' : '');
      if (i === index) item.setAttribute('aria-current', 'step');
      const number = document.createElement('span');
      number.textContent = i < index ? '✓' : i + 1;
      const label = document.createElement('span');
      label.textContent = labels[id];
      item.append(number, label);
      nav.append(item);
    }
    $('tour-counter').textContent = index + 1 + ' из ' + sequence.length;
  }
  function showStep(step, { focus = true } = {}) {
    draft.step = step;
    stash();
    for (const section of document.querySelectorAll('.tour-step'))
      section.hidden = section.id !== 'tour-' + step;
    $('tour-status').textContent = '';
    $('tour-status').classList.remove('error');
    progress();
    controls();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (focus) {
      requestAnimationFrame(() => {
        if (step === 'details') $('tour-title').focus({ preventScroll: true });
        else {
          const heading = document.querySelector('#tour-' + step + ' h1');
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
      });
    }
  }
  function readDetails() {
    draft.title = $('tour-title').value;
    draft.description = $('tour-description').value;
    draft.mode = document.querySelector('[name=tour-mode]:checked').value;
    stash();
  }
  for (const input of [
    $('tour-title'),
    $('tour-description'),
    ...document.querySelectorAll('[name=tour-mode]'),
  ])
    input.addEventListener('input', () => {
      readDetails();
      progress();
      controls();
    });
  function validateDetails() {
    readDetails();
    if (!draft.title.trim()) {
      $('tour-title').focus();
      throw new Error('Введите название презентации.');
    }
  }
  function renderThemes() {
    themePreviews.forEach((dispose) => dispose());
    themePreviews = [];
    const picker = $('tour-theme-picker');
    picker.replaceChildren();
    for (const theme of themes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tour-theme-choice';
      button.dataset.themeId = theme.id;
      const preview = document.createElement('div');
      preview.className = 'tour-theme-preview';
      const title = document.createElement('strong');
      title.textContent = theme.title;
      button.append(preview, title);
      button.addEventListener('click', () => {
        draft.custom = false;
        draft.themeId = theme.id;
        stash();
        selection();
      });
      picker.append(button);
      themePreviews.push(mountThemePreview(preview, theme));
    }
    selection();
  }
  function selection() {
    for (const button of document.querySelectorAll('[data-theme-id]'))
      button.setAttribute(
        'aria-pressed',
        String(!draft.custom && button.dataset.themeId === draft.themeId),
      );
    $('tour-create-theme').setAttribute('aria-pressed', String(draft.custom));
    const base = themes.find((item) => item.id === draft.themeId);
    $('tour-theme-base-caption').textContent =
      'Начать с темы «' + (base?.title || 'Светлая') + '» и настроить её на холсте';
    progress();
    controls();
  }
  $('tour-create-theme').addEventListener('click', () => {
    draft.custom = true;
    stash();
    selection();
  });
  async function themeEditor() {
    if (!draft.customThemeId) {
      const theme = await request('/api/themes', {
        method: 'POST',
        body: { title: ('Тема · ' + draft.title.trim()).slice(0, 200), baseThemeId: draft.themeId },
      });
      draft.customThemeId = theme.id;
      stash();
    }
    const frame = $('tour-theme-frame'),
      url = '/themes/' + encodeURIComponent(draft.customThemeId) + '?embed=tour';
    if (frame.getAttribute('src') !== url) {
      themeState = {};
      $('tour-theme-loading').hidden = false;
      themeReady = new Promise((resolve) => (themeReadyResolve = resolve));
      frame.src = url;
    }
    showStep('theme-create');
    await Promise.race([
      themeReady,
      new Promise((_, reject) =>
        pageTimeout(
          () => reject(new Error('Редактор темы загружается дольше обычного. Попробуйте ещё раз.')),
          20000,
        ),
      ),
    ]);
  }
  listen(window, 'message', (event) => {
    if (event.origin !== location.origin || event.source !== $('tour-theme-frame').contentWindow)
      return;
    const data = event.data;
    if (!data || data.themeId !== draft.customThemeId) return;
    if (data.type === 'presentation-theme-state') {
      themeState = data;
      $('tour-theme-loading').hidden = true;
      $('tour-theme-state').textContent = data.busy
        ? 'Агент работает'
        : data.saving
          ? 'Сохраняем…'
          : data.dirty
            ? 'Есть изменения'
            : 'Сохранено';
      themeReadyResolve?.();
      controls();
    }
    if (['presentation-theme-saved', 'presentation-theme-save-error'].includes(data.type)) {
      const task = themeRequests.get(data.requestId);
      if (task) {
        themeRequests.delete(data.requestId);
        clearTimeout(task.timer);
        data.type === 'presentation-theme-saved'
          ? task.resolve(data)
          : task.reject(new Error(data.error || 'Не удалось сохранить тему.'));
      }
    }
  });
  async function saveTheme() {
    if (themeState.busy || themeState.saving)
      throw new Error('Дождитесь ответа агента или сохранения темы.');
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timeout = pageTimeout(() => {
        themeRequests.delete(requestId);
        reject(new Error('Редактор не ответил. Повторите сохранение темы.'));
      }, 20000);
      themeRequests.set(requestId, { resolve, reject, timer: timeout });
      $('tour-theme-frame').contentWindow.postMessage(
        { type: 'presentation-theme-save', requestId },
        location.origin,
      );
    });
    draft.themeId = draft.customThemeId;
    themeNeedsApply = true;
    stash();
  }
  async function ensureProject() {
    validateDetails();
    const themeId = draft.custom ? draft.customThemeId : draft.themeId;
    if (!themeId) throw new Error('Выберите тему.');
    if (!draft.projectId) {
      project = await request('/api/projects', {
        method: 'POST',
        body: {
          title: draft.title.trim(),
          description: draft.description.trim(),
          creationMode: draft.mode,
          themeId,
          blank: true,
        },
      });
      draft.projectId = project.id;
      stash();
    } else {
      project = await request('/api/projects/' + encodeURIComponent(draft.projectId));
      if (
        project.title !== draft.title.trim() ||
        (project.description || '') !== draft.description.trim() ||
        project.creationMode !== draft.mode
      )
        project = await request('/api/projects/' + project.id, {
          method: 'PATCH',
          body: {
            title: draft.title.trim(),
            description: draft.description.trim(),
            creationMode: draft.mode,
            version: project.version,
          },
        });
      if (project.design?.themeId !== themeId || themeNeedsApply)
        project = await request('/api/projects/' + project.id + '/theme', {
          method: 'POST',
          body: { themeId, version: project.version },
        });
    }
    themeNeedsApply = false;
    const base = '/api/projects/' + encodeURIComponent(project.id);
    if (!materials || materials.base !== base)
      materials = new MaterialsUI({
        base,
        input: $('tour-files'),
        drop: $('tour-drop'),
        list: $('tour-materials-list'),
        status: $('tour-materials-status'),
        button: $('tour-upload'),
        onChange: controls,
      });
    await materials.load();
    const summary = $('tour-summary');
    summary.replaceChildren();
    const text = document.createElement('span'),
      name = document.createElement('strong'),
      theme = document.createElement('span'),
      mode = document.createElement('span');
    name.textContent = draft.title.trim();
    theme.textContent =
      'Тема: ' + (themes.find((item) => item.id === themeId)?.title || 'Ваша тема');
    text.append(name, theme);
    mode.className = 'summary-mode';
    mode.textContent = draft.mode === 'smart' ? '✦ Умный режим' : 'Ручной режим';
    summary.append(text, mode);
  }
  $('tour-next').addEventListener('click', async () => {
    if (busy || generating) return;
    busy = true;
    controls();
    try {
      if (draft.step === 'details') {
        validateDetails();
        showStep('themes');
      } else if (draft.step === 'themes') {
        if (draft.custom) await themeEditor();
        else {
          await ensureProject();
          showStep('materials');
        }
      } else if (draft.step === 'theme-create') {
        await saveTheme();
        await ensureProject();
        showStep('materials');
      } else if (draft.step === 'materials') {
        if (materials.blocked)
          throw new Error('Дождитесь загрузки файлов или уберите файлы с ошибкой.');
        await ensureProject();
        if (draft.mode === 'manual') {
          allowLeave = true;
          sessionStorage.removeItem(draftKey);
          navigate('/projects/' + project.id);
        } else {
          showStep('result');
          await generate();
        }
      }
    } catch (error) {
      problem(error);
    } finally {
      busy = false;
      controls();
    }
  });
  $('tour-back').addEventListener('click', () => {
    if (busy || generating) return;
    const sequence = steps(),
      index = sequence.indexOf(draft.step);
    if (index > 0) showStep(sequence[index - 1]);
  });
  listen(document, 'keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      ['tour-title'].includes(event.target.id)
    ) {
      event.preventDefault();
      $('tour-next').click();
    }
  });
  function activity(event) {
    const list = $('tour-generation-activity');
    $('tour-generation-log').hidden = false;
    let row;
    if (event.type === 'tool') {
      const key = event.toolCallId || event.name;
      row = [...list.children].find((node) => node.dataset.tool === key);
      if (!row) {
        row = document.createElement('div');
        row.dataset.tool = key;
      }
    } else row = document.createElement('div');
    row.className = 'generation-entry';
    row.textContent =
      event.type === 'tool'
        ? (event.name || 'Инструмент') + (event.status ? ' · ' + event.status : '')
        : event.text || event.message || '';
    if (!row.isConnected) list.append(row);
    list.scrollTop = list.scrollHeight;
  }
  async function ready() {
    clearInterval(timer);
    clearTimeout(pollTimer);
    generating = false;
    materials?.setLocked(false);
    $('tour-result-heading').textContent = 'Ваша презентация готова';
    $('tour-work-status').textContent =
      project.slides.length +
      ' ' +
      (project.slides.length === 1 ? 'слайд' : project.slides.length < 5 ? 'слайда' : 'слайдов');
    $('tour-work-orbit').hidden = true;
    $('tour-work-caption').textContent =
      'Посмотрите результат. Тексты, изображения и оформление можно продолжить менять в редакторе.';
    $('tour-stop').hidden = true;
    $('tour-retry').hidden = true;
    $('tour-check-provider').hidden = true;
    $('tour-ai-settings').hidden = true;
    $('tour-open-editor').hidden = false;
    $('tour-open-editor').href = '/projects/' + project.id;
    $('tour-result-viewport').hidden = false;
    const url = '/projects/' + project.id + '/view?embed=tour',
      frame = $('tour-result-frame');
    const focusResult = () =>
      requestAnimationFrame(() => {
        if (draft.step !== 'result') return;
        $('tour-result-heading').focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
    if (frame.getAttribute('src') !== url) {
      frame.addEventListener('load', focusResult, { once: true });
      frame.src = url;
    }
    controls();
    focusResult();
  }
  async function generationError(error) {
    const settings = await request('/api/ai/settings').catch(() => null),
      configured =
        settings &&
        (settings.provider === 'acp'
          ? settings.acpAvailable
          : settings.hasApiKey && settings.model);
    clearInterval(timer);
    generating = false;
    materials?.setLocked(false);
    $('tour-result-heading').textContent = 'Продолжим с того же места';
    $('tour-work-status').textContent = error.message || String(error);
    $('tour-work-caption').textContent =
      'Презентация и материалы сохранены. Можно повторить попытку или открыть редактор.';
    $('tour-work-orbit').hidden = true;
    $('tour-stop').hidden = true;
    $('tour-retry').hidden = false;
    $('tour-open-editor').hidden = false;
    $('tour-open-editor').href = '/projects/' + project.id;
    controls();
    if (!configured) {
      $('tour-ai-settings').hidden = false;
      $('tour-ai-settings').href = '/projects/' + project.id + '?connect-ai=1';
      $('tour-check-provider').hidden = false;
    }
  }
  async function generate() {
    if (generating) return;
    generating = true;
    materials?.setLocked(true);
    controls();
    abort = new AbortController();
    $('tour-generation-activity').replaceChildren();
    $('tour-generation-log').hidden = true;
    $('tour-generation-log').open = false;
    $('tour-answer').hidden = true;
    $('tour-result-viewport').hidden = true;
    $('tour-work-orbit').hidden = false;
    $('tour-stop').hidden = false;
    $('tour-retry').hidden = true;
    $('tour-ai-settings').hidden = true;
    $('tour-check-provider').hidden = true;
    $('tour-open-editor').hidden = true;
    $('tour-result-heading').textContent = 'Создаём вашу презентацию';
    $('tour-work-caption').textContent =
      'Агент изучит материалы, выберет структуру и создаст слайды. Это может занять несколько минут.';
    const start = Date.now();
    $('tour-work-status').textContent = 'Агент работает 0 сек.';
    timer = pageInterval(
      () => ($('tour-work-status').textContent = 'Агент работает ' + duration(Date.now() - start)),
      1000,
    );
    let finished = false,
      answer = '';
    try {
      const response = await fetch('/api/projects/' + project.id + '/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: abort.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Не удалось запустить агента.');
      }
      let buffer = '';
      const decoder = new TextDecoder(),
        reader = response.body.getReader();
      const handle = (raw) => {
        let type = '',
          data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) return;
        const event = JSON.parse(data);
        if (['activity', 'tool', 'status'].includes(type)) activity({ ...event, type });
        if (type === 'error') throw new Error(event.error || event.message || 'Ошибка агента');
        if (type === 'done') {
          if (event.cancelled) throw new Error('Создание остановлено.');
          finished = true;
          answer = event.message?.content || '';
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handle(raw);
        }
      }
      if (buffer.trim()) handle(buffer);
      if (!finished)
        throw new Error('Соединение прервалось. Сохранённые слайды остались в проекте.');
      project = await request('/api/projects/' + project.id);
      if (project.creation?.status !== 'ready')
        throw new Error('Агент завершил ответ, но презентация ещё не готова. Продолжите создание.');
      if (answer) {
        $('tour-answer').textContent = answer;
        $('tour-answer').hidden = false;
      }
      await ready();
    } catch (error) {
      await generationError(
        error.name === 'AbortError' ? new Error('Создание остановлено.') : error,
      );
    } finally {
      clearInterval(timer);
      abort = null;
      generating = false;
      controls();
    }
  }
  async function observeGeneration() {
    generating = true;
    controls();
    $('tour-work-status').textContent = 'Агент уже работает. Проверяем результат…';
    $('tour-stop').hidden = false;
    const check = async () => {
      try {
        project = await request('/api/projects/' + project.id);
        if (project.creation?.status === 'ready') {
          await ready();
          return;
        }
        if (project.creation?.status !== 'generating') {
          await generationError(
            new Error('Предыдущий запуск прервался. Можно продолжить с сохранённых слайдов.'),
          );
          return;
        }
        pollTimer = pageTimeout(check, 2000);
      } catch (error) {
        await generationError(error);
      }
    };
    await check();
  }
  $('tour-stop').addEventListener('click', () => {
    abort?.abort();
    request('/api/projects/' + project.id + '/chat/cancel', { method: 'POST' }).catch(problem);
  });
  $('tour-retry').addEventListener('click', () => generate());
  $('tour-check-provider').addEventListener('click', () => generate());
  $('tour-open-editor').addEventListener('click', () => {
    allowLeave = true;
    sessionStorage.removeItem(draftKey);
  });
  for (const link of document.querySelectorAll('[data-tour-exit]'))
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (!draft.title && !draft.projectId && !themeState.dirty) {
        allowLeave = true;
        navigate('/projects');
        return;
      }
      $('tour-exit-description').textContent = generating
        ? 'Создание остановится. Уже созданные слайды и материалы останутся в проектах.'
        : themeState.dirty
          ? 'Тема содержит несохранённые изменения. Они не будут сохранены при выходе; остальные шаги тура можно продолжить в этой вкладке.'
          : draft.projectId
            ? 'Черновик и материалы останутся в проектах. Тур можно продолжить позже.'
            : 'Шаги сохранятся в этой вкладке. Можно будет вернуться к туру.';
      $('tour-exit-dialog').showModal();
    });
  $('tour-exit-cancel').addEventListener('click', () => $('tour-exit-dialog').close());
  $('tour-exit-confirm').addEventListener('click', () => {
    allowLeave = true;
    abort?.abort();
    navigate('/projects');
  });
  listen(window, 'beforeunload', (event) => {
    if (!allowLeave && (generating || materials?.uploading || themeState.dirty)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  try {
    const supplied = new URLSearchParams(location.search).get('project');
    if (supplied) {
      const snapshot = await request('/api/projects/' + encodeURIComponent(supplied));
      draft = {
        ...fresh(),
        title: snapshot.title,
        description: snapshot.description || '',
        mode: snapshot.creationMode || 'smart',
        themeId: snapshot.design?.themeId || 'light',
        projectId: snapshot.id,
        step: snapshot.creation?.status === 'pending' ? 'materials' : 'result',
      };
      project = snapshot;
      stash();
    }
    themes = (await request('/api/themes')).themes;
    if (!themes.some((item) => item.id === draft.themeId) && !draft.customThemeId)
      draft.themeId = themes.find((item) => item.id === 'light')?.id || themes[0]?.id;
    $('tour-title').value = draft.title;
    $('tour-description').value = draft.description;
    document.querySelector(
      '[name=tour-mode][value=' + (draft.mode === 'manual' ? 'manual' : 'smart') + ']',
    ).checked = true;
    renderThemes();
    const step = steps().includes(draft.step) ? draft.step : 'details';
    if (step === 'theme-create') await themeEditor();
    else if (['materials', 'result'].includes(step)) {
      await ensureProject();
      showStep(step);
      if (step === 'result') {
        if (project.creation?.status === 'ready') await ready();
        else if (project.creation?.status === 'generating') await observeGeneration();
        else await generationError(new Error('Можно продолжить создание презентации.'));
      }
    } else showStep(step);
  } catch (error) {
    showStep('details');
    problem(error);
  } finally {
    busy = false;
    for (const input of document.querySelectorAll('#tour-details input,#tour-details textarea'))
      input.disabled = false;
    controls();
  }
}
