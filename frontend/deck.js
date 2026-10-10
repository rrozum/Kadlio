// Автономный просмотрщик остаётся одним скриптом: экспорт HTML встраивает его для работы офлайн.
(() => {
  'use strict';
  const slides = JSON.parse(document.getElementById('deck-data').textContent);
  const $ = (id) => document.getElementById(id);
  import('/modules/theme.js').then(({ initTheme }) => initTheme($('theme-toggle'))).catch(() => {});
  const isPresenter = new URLSearchParams(location.search).get('presenter') === '1';
  const project = JSON.parse(document.getElementById('project-data').textContent);
  const guestComments = project.readOnly && project.publicShare?.comments,
    guestNotes = project.readOnly && project.publicShare?.notes;
  document.body.classList.toggle('guest-comments', !!guestComments);
  document.body.classList.toggle('guest-notes', !!guestNotes);
  if (guestComments) {
    const label = document.createElement('label');
    label.className = 'guest-name';
    label.textContent = 'Ваше имя · необязательно';
    const input = document.createElement('input');
    input.id = 'guest-name';
    input.maxLength = 80;
    input.autocomplete = 'name';
    label.append(input);
    $('annotation-form').insertBefore(label, $('annotation-text'));
    $('annotation-form').querySelector('[type=submit]').textContent = 'Отправить автору';
  }
  const plannedMs =
    slides
      .filter((s) => s.kind !== 'backup' && s.kind !== 'questions')
      .reduce((n, s) => n + (s.seconds || 0) * 1000, 0) || 1200000;
  let savingNotes = false,
    savedNotes = slides.map((s) => s.notes),
    lastSavedFile = '',
    notesTimer = null;
  let noteVersions = slides.map((s) => s.notesVersion || 0);
  let index = 0,
    popup = null,
    running = false,
    elapsedMs = 0,
    lastTick = performance.now(),
    slideElapsedMs = 0;
  let touchStart = null,
    blank = false,
    toastHandle = null;
  const audienceSlides = Array.from(document.querySelectorAll('#deck-stage > .slide'));
  let initialized = false,
    overviewBuilt = false;
  const overviewCards = [];
  let playEffect = () => {},
    stopEffect = () => {},
    boundaryEffect = () => null;
  let runtimePlayer = null;
  if (!window.__PRESENTATION_EXPORT__)
    import('/shared/addons/motion/player.js')
      .then((module) => {
        runtimePlayer = module;
        if (initialized) activateRuntime(index);
      })
      .catch(() => {});
  function activateRuntime(slideIndex, effect) {
    if (!runtimePlayer || isPresenter || !project.runtimeSlides?.includes(slides[slideIndex].id))
      return;
    const base = project.publicShare?.runtimeBase || (project.apiBase || '/api') + '/slides',
      url =
        base +
        '/' +
        slides[slideIndex].id +
        '/runtime' +
        (effect?.transitionId ? '?transitionId=' + encodeURIComponent(effect.transitionId) : '');
    runtimePlayer.playRuntime(audienceSlides[slideIndex], {
      url,
      sceneId: slides[slideIndex].id,
      onError: (message) => toast(message),
      onNavigate: (command) => go(index + (command === 'next' ? 1 : -1)),
    });
  }
  if (!window.__PRESENTATION_EXPORT__)
    import('/shared/addons/motion/runtime.js')
      .then((module) => {
        playEffect = module.playSlideEffect;
        stopEffect = module.stopSlideEffects;
      })
      .catch(() => {});
  if (!window.__PRESENTATION_EXPORT__)
    import('/shared/presentation/timeline.js')
      .then((module) => {
        boundaryEffect = (from, to) =>
          module.boundaryTransition({ slides, timeline: project.timeline }, from, to);
      })
      .catch(() => {});
  let annotations = project.annotations,
    annotationMode = false,
    annotationDraft = null;
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const clock = (ms) => {
    const n = Math.floor(Math.max(0, ms) / 1000);
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };
  const timing = (s) =>
    s.kind === 'questions'
      ? 'Вопросы: 5–10 минут'
      : s.kind === 'backup'
        ? 'Резервный слайд · вне тайминга'
        : `${clock(s.seconds * 1000)} на слайд · ${clock(slides.slice(0, index).reduce((a, b) => a + b.seconds, 0) * 1000)}–${clock(slides.slice(0, index + 1).reduce((a, b) => a + b.seconds, 0) * 1000)} по плану`;
  const toast = (text) => {
    $('toast').textContent = text;
    $('toast').classList.add('show');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => $('toast').classList.remove('show'), 3500);
  };
  async function api(url, method = 'GET', data) {
    const response = await fetch(
      url.startsWith('/api/') && !url.startsWith('/api/logout') && project.apiBase
        ? project.apiBase + url.slice(4)
        : url,
      {
        method,
        headers: data ? { 'Content-Type': 'application/json' } : {},
        body: data ? JSON.stringify(data) : undefined,
      },
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Ошибка сервера');
    return value;
  }
  function annotationStatus(text) {
    $('annotation-status').textContent =
      text ||
      (guestComments
        ? 'Комментарий увидит автор. Агент получит его только по решению автора.'
        : 'Сохраняются в проекте.');
  }
  function renderAnnotations() {
    const layer = $('annotation-layer');
    layer.replaceChildren();
    annotations.forEach((a, i) => {
      if (a.slideId !== slides[index].id) return;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'annotation-pin';
      pin.textContent = String(i + 1);
      pin.style.left = `${a.x * 100}%`;
      pin.style.top = `${a.y * 100}%`;
      pin.title = a.comment;
      pin.setAttribute('aria-label', `Комментарий ${i + 1}: ${a.comment}`);
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        openAnnotation(a);
      });
      layer.append(pin);
    });
    $('annotation-count').textContent = String(annotations.length);
    $('annotation-export').disabled = !annotations.length;
    const list = $('annotation-list');
    list.replaceChildren();
    if (!annotations.length) {
      const p = document.createElement('p');
      p.className = 'annotation-empty';
      p.textContent = 'Пока нет комментариев. Выберите точку на слайде.';
      list.append(p);
    }
    annotations.forEach((a, i) => {
      const slideIndex = slides.findIndex((s) => s.id === a.slideId),
        button = document.createElement('button');
      button.type = 'button';
      button.className = 'annotation-item';
      const title = document.createElement('strong');
      title.textContent = `${i + 1}. Слайд ${slideIndex + 1} · ${slides[slideIndex].title}`;
      const comment = document.createElement('span');
      comment.textContent = a.comment;
      button.append(title, comment);
      button.addEventListener('click', () => {
        go(slideIndex);
        openAnnotation(a);
      });
      list.append(button);
    });
  }
  function setAnnotationMode(enabled) {
    if (project.readOnly && !guestComments) return;
    annotationMode = enabled;
    document.body.classList.toggle('annotating', enabled);
    $('annotation-toggle').setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      closeOverlays();
      renderAnnotations();
    } else closeAnnotationPanel();
  }
  function closeAnnotationPanel() {
    $('annotation-panel').classList.remove('open');
    annotationDraft = null;
    $('annotation-form').hidden = true;
  }
  function openAnnotation(a) {
    closeOverlays();
    annotationDraft = { ...a };
    $('annotation-panel').classList.add('open');
    $('annotation-form').hidden = false;
    const n = slides.findIndex((s) => s.id === a.slideId) + 1;
    $('annotation-location').textContent =
      `Слайд ${n} · точка ${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%`;
    $('annotation-text').value = a.comment;
    $('annotation-delete').hidden =
      project.readOnly || !annotations.some((item) => item.id === a.id);
    $('annotation-text').readOnly = !!(
      project.readOnly && annotations.some((item) => item.id === a.id)
    );
    $('annotation-form').querySelector('[type=submit]').hidden = $('annotation-text').readOnly;
    annotationStatus();
    $('annotation-text').focus();
  }
  $('annotation-toggle').addEventListener('click', () => setAnnotationMode(!annotationMode));
  $('annotation-list-toggle').addEventListener('click', () => {
    closeOverlays();
    closeAnnotationPanel();
    $('annotation-panel').classList.add('open');
    annotationStatus();
  });
  $('annotation-close').addEventListener('click', closeAnnotationPanel);
  $('stage-shell').addEventListener('click', (e) => {
    if (!annotationMode || e.target.closest('button') || e.target.closest('#annotation-hint'))
      return;
    const bounds = $('stage-shell').getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)),
      y = Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height));
    const anchor = e.target.closest('h1,h2,h3,p,b,span,pre,article,.card');
    openAnnotation({
      id: crypto.randomUUID(),
      slideId: slides[index].id,
      x,
      y,
      anchorText: anchor?.textContent.trim().slice(0, 300) || '',
      comment: '',
      createdAt: new Date().toISOString(),
    });
  });
  $('annotation-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!annotationDraft) return;
    const submitted = annotationDraft,
      comment = $('annotation-text').value.trim();
    if (!comment) return;
    const button = e.submitter;
    button.disabled = true;
    annotationStatus('Сохранение…');
    try {
      const payload = guestComments
        ? {
            slideId: submitted.slideId,
            x: submitted.x,
            y: submitted.y,
            anchorText: submitted.anchorText || '',
            comment,
            name: $('guest-name').value,
          }
        : { ...submitted, comment };
      const result = await api(
        guestComments ? project.publicShare.commentUrl : '/api/annotations',
        'POST',
        payload,
      );
      const saved = result.annotation || result;
      const existing = annotations.findIndex((a) => a.id === saved.id);
      if (existing < 0) annotations.push(saved);
      else annotations[existing] = saved;
      renderAnnotations();
      if (annotationDraft === submitted) closeAnnotationPanel();
      toast(guestComments ? 'Комментарий отправлен автору' : 'Комментарий сохранён в проекте');
    } catch (error) {
      if (annotationDraft === submitted) annotationStatus(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $('annotation-delete').addEventListener('click', async () => {
    if (!annotationDraft) return;
    const id = annotationDraft.id;
    try {
      await api('/api/annotations/' + encodeURIComponent(id), 'DELETE');
      annotations = annotations.filter((a) => a.id !== id);
      renderAnnotations();
      closeAnnotationPanel();
    } catch (error) {
      annotationStatus(error.message);
    }
  });
  $('annotation-import').addEventListener('click', () => $('annotation-import-file').click());
  $('annotation-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      annotations = await api('/api/annotations/import', 'POST', {
        annotations: Array.isArray(value) ? value : value.annotations,
      });
      renderAnnotations();
      annotationStatus('Комментарии импортированы в проект.');
    } catch (error) {
      annotationStatus('Не удалось импортировать: ' + error.message);
    } finally {
      e.target.value = '';
    }
  });
  $('annotation-export').addEventListener('click', () => {
    const data = {
      format: 'slide-annotations',
      version: 1,
      presentation: 'presentation.html',
      exportedAt: new Date().toISOString(),
      coordinateSystem: 'Normalized x/y from the top-left of a slide, in [0,1].',
      annotations: annotations.map((a, i) => ({
        number: i + 1,
        ...a,
        slideNumber: slides.findIndex((s) => s.id === a.slideId) + 1,
        slideTitle: slides.find((s) => s.id === a.slideId).title,
      })),
    };
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = 'presentation-annotations.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function resize() {
    const scale = Math.max(0.05, Math.min((innerWidth - 32) / 1280, (innerHeight - 98) / 720));
    document.documentElement.style.setProperty('--scale', scale);
    const box = $('presenter-preview-box');
    if (box && box.firstElementChild)
      box.firstElementChild.style.transform = `scale(${box.clientWidth / 1280})`;
  }
  function noteHTML(s) {
    if (project.readOnly)
      return '<div class="note-text">' + (guestNotes ? paragraphHTML(s.notes) : '') + '</div>';
    return `<div class="note-text" contenteditable="plaintext-only" role="textbox" aria-label="Текст доклада для текущего слайда" aria-multiline="true" spellcheck="true" data-slide="${index}">${paragraphHTML(s.notes)}</div>`;
  }
  function paragraphHTML(text) {
    return text
      .split(/\n+/)
      .filter(Boolean)
      .map((p) => `<p>${esc(p.trim())}</p>`)
      .join('');
  }
  function notesDirty() {
    return slides.some((s, i) => s.notes !== savedNotes[i]);
  }
  function editStatus(message) {
    const dirty = notesDirty();
    const text =
      message ||
      (dirty
        ? 'Есть несохранённые изменения'
        : lastSavedFile
          ? 'Сохранено в проекте'
          : 'Сохраняется автоматически');
    ['notes-save-status', 'presenter-notes-save-status'].forEach((id) => {
      $(id).textContent = text;
      $(id).classList.toggle('dirty', dirty);
    });
    ['notes-save', 'presenter-notes-save'].forEach(
      (id) => ($(id).disabled = savingNotes || !dirty),
    );
  }
  function updateNote(slideIndex, text, remote = false) {
    if (project.readOnly) return;
    if (
      !Number.isInteger(slideIndex) ||
      slideIndex < 0 ||
      slideIndex >= slides.length ||
      typeof text !== 'string'
    )
      return;
    if (slides[slideIndex].notes === text) return;
    slides[slideIndex].notes = text;
    document.querySelectorAll(`.note-text[data-slide="${slideIndex}"]`).forEach((el) => {
      if (remote || (el !== document.activeElement && !el.contains(document.activeElement)))
        el.innerHTML = paragraphHTML(text);
    });
    editStatus();
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, 500);
    if (!remote) {
      const target = isPresenter ? window.opener : popup;
      if (target && !target.closed)
        target.postMessage(
          { type: 'deck-note-edit', index: slideIndex, notes: text },
          location.origin,
        );
    }
  }
  async function saveNotes() {
    if (project.readOnly) return true;
    clearTimeout(notesTimer);
    if (savingNotes) {
      await savingNotes;
      return notesDirty() ? saveNotes() : true;
    }
    if (!notesDirty()) return true;
    const changes = slides.flatMap((s, i) =>
      s.notes === savedNotes[i] ? [] : [{ id: s.id, notes: s.notes, version: noteVersions[i] }],
    );
    editStatus('Сохранение…');
    savingNotes = (async () => {
      try {
        const results = await api('/api/notes', 'PATCH', { changes });
        for (const item of results) {
          const i = slides.findIndex((s) => s.id === item.id);
          savedNotes[i] = item.notes;
          noteVersions[i] = item.version;
        }
        lastSavedFile = 'project';
        const target = isPresenter ? window.opener : popup;
        if (target && !target.closed)
          target.postMessage(
            {
              type: 'deck-notes-saved',
              notes: savedNotes,
              versions: noteVersions,
              name: lastSavedFile,
            },
            location.origin,
          );
        editStatus();
        return true;
      } catch (error) {
        editStatus('Не сохранено: ' + error.message);
        return false;
      }
    })();
    const ok = await savingNotes;
    savingNotes = false;
    editStatus(ok ? undefined : $('notes-save-status').textContent);
    if (ok && notesDirty()) notesTimer = setTimeout(saveNotes, 100);
    return ok;
  }
  addEventListener('beforeunload', (e) => {
    if (notesDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  $('export-toggle').addEventListener('click', () => {
    closeAnnotationPanel();
    toggleModal('export-dialog');
  });
  let exporting = false;
  async function exportDeck(format) {
    if (exporting) return;
    exporting = true;
    ['export-pdf', 'export-pptx', 'export-html'].forEach((id) => ($(id).disabled = true));
    $('export-status').textContent = 'Сохраняем заметки и готовим ' + format.toUpperCase() + '…';
    try {
      while (notesDirty())
        if (!(await saveNotes()))
          throw new Error('Сначала сохраните заметки: ' + $('notes-save-status').textContent);
      const response = await fetch((project.apiBase || '/api') + '/export/' + format, {
        method: 'POST',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Экспорт не выполнен');
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = url;
      link.download = 'presentation.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('export-status').textContent =
        'Файл готов. Все ' + slides.length + ' слайда, без меток и панелей.';
      const warning = response.headers.get('X-Presentation-Warnings');
      if (warning) $('export-status').textContent += ' ' + decodeURIComponent(warning);
    } catch (error) {
      $('export-status').textContent = error.message;
    } finally {
      exporting = false;
      ['export-pdf', 'export-pptx', 'export-html'].forEach((id) => ($(id).disabled = false));
    }
  }
  $('logout')?.addEventListener('click', async () => {
    try {
      if (!(await saveNotes())) return;
      await api('/api/logout', 'POST');
      location.href = '/login';
    } catch (error) {
      toast(error.message);
    }
  });
  $('export-pdf').addEventListener('click', () => exportDeck('pdf'));
  $('export-pptx').addEventListener('click', () => exportDeck('pptx'));
  $('export-html').addEventListener('click', () => exportDeck('html'));
  function drawNotes() {
    const s = slides[index];
    $('notes-title').textContent = `${index + 1}. ${s.title}`;
    $('notes-timing').textContent = timing(s);
    $('notes-body').innerHTML = noteHTML(s);
    if (isPresenter) {
      $('presenter-notes-title').textContent = s.title;
      $('presenter-notes-body').innerHTML = noteHTML(s);
      $('presenter-slide-label').textContent =
        `Слайд ${index + 1} / ${slides.length} · ${timing(s)}`;
      const clone = audienceSlides[index].cloneNode(true);
      clone.removeAttribute('id');
      clone.removeAttribute('aria-hidden');
      delete clone.dataset.effectRunning;
      delete clone.dataset.effectGhost;
      clone.classList.add('active');
      $('presenter-preview-box').replaceChildren(clone);
      $('next-title').textContent = slides[index + 1]?.title || 'Конец презентации';
      resize();
    }
    editStatus();
  }
  function hashIndex() {
    const found = slides.findIndex((slide) => '#' + slide.id === location.hash);
    return found < 0 ? 0 : found;
  }
  function flushClock() {
    const now = performance.now();
    if (running) {
      elapsedMs += now - lastTick;
      slideElapsedMs += now - lastTick;
    }
    lastTick = now;
  }
  function clockUI() {
    const text = `${clock(elapsedMs)} / ${clock(plannedMs)}`;
    $('timer').textContent = text;
    $('timer').classList.toggle('over', elapsedMs >= plannedMs);
    $('timer').classList.toggle('paused', !running);
    $('timer').setAttribute('aria-pressed', String(running));
    $('timer').setAttribute('aria-label', running ? 'Приостановить таймер' : 'Запустить таймер');
    $('timer').title = running ? 'Приостановить · T' : 'Запустить таймер · T';
    $('presenter-clock').textContent = clock(elapsedMs);
    $('presenter-clock').classList.toggle('over', elapsedMs >= plannedMs);
    $('presenter-timer-toggle').textContent = running ? 'Пауза' : 'Старт';
    $('presenter-slide-clock').textContent = `На этом слайде: ${clock(slideElapsedMs)}`;
  }
  function sendState() {
    if (!isPresenter && popup && !popup.closed)
      popup.postMessage(
        { type: 'deck-state', index, running, elapsedMs, slideElapsedMs },
        location.origin,
      );
  }
  function go(target, fromRemote = false) {
    target = Math.max(0, Math.min(slides.length - 1, target));
    if (isPresenter && window.opener && !window.opener.closed && !fromRemote) {
      window.opener.postMessage(
        { type: 'deck-command', command: 'go', index: target },
        location.origin,
      );
      return;
    }
    if (initialized && target === index) return;
    flushClock();
    if (target !== index) slideElapsedMs = 0;
    const previousIndex = index;
    const previous = audienceSlides[index];
    runtimePlayer?.stopRuntime(previous);
    stopEffect(previous);
    index = target;
    const current = audienceSlides[index];
    stopEffect(current);
    if (previous !== current) {
      previous.classList.remove('active');
      previous.setAttribute('aria-hidden', 'true');
    }
    current.classList.add('active');
    current.setAttribute('aria-hidden', 'false');
    const transition = boundaryEffect(slides[previousIndex].id, slides[index].id);
    if (initialized && !isPresenter && previousIndex !== index && !transition?.snippet)
      Promise.resolve(
        playEffect(current, transition, { previous, direction: index > previousIndex ? 1 : -1 }),
      ).catch(() => {});
    activateRuntime(index, transition);
    initialized = true;
    const s = slides[index];
    $('counter').textContent = `${index + 1} / ${slides.length}`;
    $('prev').disabled = index === 0;
    $('next').disabled = index === slides.length - 1;
    $('presenter-prev').disabled = index === 0;
    $('presenter-next').disabled = index === slides.length - 1;
    $('progress-fill').style.width = `${(100 * (index + 1)) / slides.length}%`;
    $('slide-announcement').textContent = `Слайд ${index + 1}. ${s.title}`;
    document.title = `${index + 1}. ${s.title} — ${isPresenter ? 'Спикер' : 'Презентация'}`;
    const hash = '#' + s.id;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    overviewCards[previousIndex]?.classList.remove('selected');
    overviewCards[index]?.classList.add('selected');
    closeAnnotationPanel();
    renderAnnotations();
    drawNotes();
    clockUI();
    if (!fromRemote) sendState();
  }
  function command(cmd) {
    if (isPresenter && window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'deck-command', command: cmd }, location.origin);
      return;
    }
    flushClock();
    if (cmd === 'timer') running = !running;
    if (cmd === 'reset') {
      elapsedMs = 0;
      slideElapsedMs = 0;
      running = false;
    }
    clockUI();
    sendState();
  }
  let lastFocused = null;
  function closeOverlays() {
    document.querySelectorAll('.modal.open').forEach((el) => el.classList.remove('open'));
    $('notes-drawer').classList.remove('open');
    $('notes-toggle').setAttribute('aria-pressed', 'false');
    if (lastFocused) {
      lastFocused.focus();
      lastFocused = null;
    }
  }
  function toggleModal(id) {
    const was = $(id).classList.contains('open');
    closeOverlays();
    if (id === 'overview' && !was) buildOverview();
    if (!was) {
      lastFocused = document.activeElement;
      $(id).classList.add('open');
      $(id).querySelector('button')?.focus();
    }
  }
  function toggleNotes() {
    if (project.readOnly && !guestNotes) return;
    setAnnotationMode(false);
    const was = $('notes-drawer').classList.contains('open');
    closeOverlays();
    if (!was) {
      lastFocused = document.activeElement;
      $('notes-drawer').classList.add('open');
      $('notes-toggle').setAttribute('aria-pressed', 'true');
      $('notes-close').focus();
    }
  }
  function buildOverview() {
    if (overviewBuilt) return;
    overviewBuilt = true;
    const grid = $('overview-grid');
    const fragment = document.createDocumentFragment();
    const hydrate = (thumb) => {
      const clone = audienceSlides[Number(thumb.dataset.slideIndex)].cloneNode(true);
      clone.removeAttribute('id');
      clone.removeAttribute('aria-hidden');
      delete clone.dataset.effectRunning;
      delete clone.dataset.effectGhost;
      clone.classList.add('active');
      clone.querySelectorAll('.slide-runtime-frame').forEach((frame) => frame.remove());
      clone.classList.remove('runtime-ready');
      thumb.replaceChildren(clone);
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.isIntersecting) {
                  hydrate(entry.target);
                  observer.unobserve(entry.target);
                }
            },
            { root: $('overview'), rootMargin: '180px' },
          )
        : null;
    slides.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'overview-card';
      b.type = 'button';
      b.setAttribute('aria-label', `Слайд ${i + 1}. ${s.title}`);
      b.classList.toggle('selected', i === index);
      overviewCards.push(b);
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.setAttribute('aria-hidden', 'true');
      thumb.dataset.slideIndex = String(i);
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = `${String(i + 1).padStart(2, '0')} · ${s.title}`;
      const small = document.createElement('small');
      small.textContent =
        s.kind === 'main'
          ? clock(s.seconds * 1000)
          : s.kind === 'questions'
            ? '5–10 минут на вопросы'
            : 'Резерв';
      desc.append(small);
      b.append(thumb, desc);
      b.addEventListener('click', () => {
        go(i);
        closeOverlays();
      });
      fragment.append(b);
      if (observer) observer.observe(thumb);
      else hydrate(thumb);
    });
    grid.append(fragment);
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      toast('Полноэкранный режим недоступен здесь. Откройте HTML в браузере и нажмите F11.');
    }
  }
  function openPresenter() {
    if (isPresenter) return;
    if (popup && !popup.closed) {
      popup.focus();
      sendState();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('presenter', '1');
    popup = window.open(
      url.href,
      'presentation-presenter-' + location.pathname,
      'width=1360,height=900',
    );
    if (!popup)
      toast('Браузер заблокировал окно спикера. Разрешите всплывающие окна для этой страницы.');
  }
  function toggleBlank() {
    blank = !blank;
    $('blank-screen').classList.toggle('show', blank);
  }
  $('prev').addEventListener('click', () => go(index - 1));
  $('next').addEventListener('click', () => go(index + 1));
  $('counter').addEventListener('click', () => toggleModal('overview'));
  $('overview-toggle').addEventListener('click', () => toggleModal('overview'));
  $('help-toggle').addEventListener('click', () => toggleModal('help'));
  $('notes-toggle').addEventListener('click', toggleNotes);
  $('fullscreen-toggle').addEventListener('click', fullscreen);
  $('presenter-toggle').addEventListener('click', openPresenter);
  $('timer').addEventListener('click', () => command('timer'));
  $('timer-reset').addEventListener('click', () => command('reset'));
  $('presenter-prev').addEventListener('click', () => go(index - 1));
  $('presenter-next').addEventListener('click', () => go(index + 1));
  $('presenter-timer-toggle').addEventListener('click', () => command('timer'));
  $('presenter-timer-reset').addEventListener('click', () => command('reset'));
  $('notes-close').addEventListener('click', closeOverlays);
  ['notes-body', 'presenter-notes-body'].forEach((id) =>
    $(id).addEventListener('input', (e) => {
      const editor = e.target.closest('.note-text[contenteditable]');
      if (editor)
        updateNote(Number(editor.dataset.slide), editor.innerText.replace(/\r\n?/g, '\n').trim());
    }),
  );
  $('notes-save').addEventListener('click', saveNotes);
  $('presenter-notes-save').addEventListener('click', saveNotes);
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', closeOverlays));
  $('blank-screen').addEventListener('click', toggleBlank);
  $('stage-shell').addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !annotationMode) touchStart = { x: e.clientX, y: e.clientY };
  });
  $('stage-shell').addEventListener('pointerup', (e) => {
    if (!touchStart) return;
    const dx = e.clientX - touchStart.x,
      dy = e.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) go(index + (dx < 0 ? 1 : -1));
  });
  $('stage-shell').addEventListener('pointercancel', () => (touchStart = null));
  document.addEventListener('keydown', (e) => {
    if (
      project.readOnly &&
      (['p', 'з', 'e', 'у'].includes(e.key.toLowerCase()) ||
        (!guestNotes && ['n', 'т'].includes(e.key.toLowerCase())) ||
        (!guestComments && ['a', 'ф'].includes(e.key.toLowerCase())))
    )
      return;
    const key = e.key.toLowerCase();
    if (
      (e.ctrlKey || e.metaKey) &&
      key === 's' &&
      (isPresenter || $('notes-drawer').classList.contains('open'))
    ) {
      e.preventDefault();
      saveNotes();
      return;
    }
    if (key === 'escape') {
      if (blank) toggleBlank();
      else if ($('annotation-panel').classList.contains('open')) closeAnnotationPanel();
      else if (annotationMode) setAnnotationMode(false);
      else closeOverlays();
      return;
    }
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
    )
      return;
    if (key === 'b' || key === 'и') {
      e.preventDefault();
      toggleBlank();
      return;
    }
    if (blank) return;
    const open =
      document.querySelector('.modal.open') || $('notes-drawer').classList.contains('open');
    if (e.key === 'Tab' && open) {
      const root = document.querySelector('.modal.open') || $('notes-drawer');
      const focusable = Array.from(
        root.querySelectorAll('button,a[href],[contenteditable]'),
      ).filter((el) => !el.disabled);
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (
      ['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) ||
      (e.key === ' ' && e.target.tagName !== 'BUTTON')
    ) {
      if (open && !$('notes-drawer').classList.contains('open')) return;
      e.preventDefault();
      go(index + 1);
      return;
    }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
      if (open && !$('notes-drawer').classList.contains('open')) return;
      e.preventDefault();
      go(index - 1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      go(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      go(slides.length - 1);
      return;
    }
    if ((key === 'e' || key === 'у') && !isPresenter) {
      e.preventDefault();
      toggleModal('export-dialog');
    }
    if (key === 'o' || key === 'щ') {
      e.preventDefault();
      toggleModal('overview');
    }
    if ((key === 'a' || key === 'ф') && !isPresenter) {
      e.preventDefault();
      setAnnotationMode(!annotationMode);
    }
    if (key === 'n' || key === 'т') {
      e.preventDefault();
      if (!isPresenter) toggleNotes();
    }
    if (key === 'p' || key === 'з') {
      e.preventDefault();
      openPresenter();
    }
    if (key === 'f' || key === 'а') {
      e.preventDefault();
      fullscreen();
    }
    if (key === 't' || key === 'е') {
      e.preventDefault();
      command('timer');
    }
    if (key === 'r' || key === 'к') {
      e.preventDefault();
      command('reset');
    }
    if (key === '?' || key === 'h' || key === 'р') {
      e.preventDefault();
      toggleModal('help');
    }
  });
  addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    const partner = isPresenter ? window.opener : popup;
    if (e.source === partner && partner) {
      if (d.type === 'deck-note-edit') updateNote(d.index, d.notes, true);
      if (
        d.type === 'deck-notes-sync' &&
        isPresenter &&
        Array.isArray(d.notes) &&
        d.notes.length === slides.length &&
        d.notes.every((s) => typeof s === 'string')
      ) {
        d.notes.forEach((text, i) => updateNote(i, text, true));
        if (Array.isArray(d.savedNotes) && d.savedNotes.length === slides.length)
          savedNotes = d.savedNotes;
        if (Array.isArray(d.versions)) noteVersions = d.versions;
        lastSavedFile = typeof d.name === 'string' ? d.name : '';
        editStatus();
      }
      if (
        d.type === 'deck-notes-saved' &&
        Array.isArray(d.notes) &&
        d.notes.length === slides.length &&
        d.notes.every((s) => typeof s === 'string')
      ) {
        savedNotes = d.notes;
        if (Array.isArray(d.versions)) noteVersions = d.versions;
        lastSavedFile = typeof d.name === 'string' ? d.name : '';
        editStatus();
      }
    }
    if (isPresenter && e.source === window.opener && d.type === 'deck-state') {
      if (!Number.isInteger(d.index) || d.index < 0 || d.index >= slides.length) return;
      running = Boolean(d.running);
      elapsedMs = Math.max(0, Number(d.elapsedMs) || 0);
      slideElapsedMs = Math.max(0, Number(d.slideElapsedMs) || 0);
      lastTick = performance.now();
      if (index !== d.index) go(d.index, true);
      else clockUI();
      $('connection-status').textContent = 'Связано с окном показа. Кнопки управляют презентацией.';
    }
    if (!isPresenter && e.source === popup) {
      if (d.type === 'deck-ready') {
        sendState();
        popup.postMessage(
          {
            type: 'deck-notes-sync',
            notes: slides.map((s) => s.notes),
            savedNotes,
            versions: noteVersions,
            name: lastSavedFile,
          },
          location.origin,
        );
      }
      if (d.type === 'deck-command') {
        if (d.command === 'go' && Number.isInteger(d.index)) go(d.index);
        if (d.command === 'timer' || d.command === 'reset') command(d.command);
      }
    }
  });
  addEventListener('resize', resize);
  addEventListener('hashchange', () => go(hashIndex()));
  if (isPresenter) {
    document.body.classList.add('presenter');
    if (window.opener && !window.opener.closed)
      window.opener.postMessage({ type: 'deck-ready' }, location.origin);
    else
      $('connection-status').textContent =
        'Открыто отдельно. Слайды и таймер работают локально. Для связи откройте это окно кнопкой P в презентации.';
  }
  resize();
  go(hashIndex(), true);
  setInterval(() => {
    flushClock();
    clockUI();
    if (!isPresenter) sendState();
  }, 250);
})();
