import { listen, pageTimeout } from './modules/page-lifecycle.js';
import { preserveLocalDrafts } from './engine/editor-drafts.js';
import { request } from './modules/api.js';
import { SlideCanvas } from './engine/canvas.js';
import { initTheme } from './modules/theme.js';
import { applyIcons } from './modules/icons.js';
import { PresentationDesignUI } from './modules/presentation-design-ui.js';
import { ProjectLive } from './modules/project-live.js';
import { MaterialsUI } from './modules/materials-ui.js';
import { icon } from './modules/icons.js';
import { FilmstripTimeline } from './modules/filmstrip-timeline.js';
import { transitionForGap } from '../shared/presentation/timeline.js';
import { SlideLayers } from './engine/layers.js';
import { mountAuthoringTools } from './modules/slide-authoring-ui.js';
import { createEditorPersistence } from './editor/persistence.js';
import { createEditorNavigation } from './editor/navigation.js';
import { createEditorAnnotations } from './editor/annotations.js';
import { createEditorChat } from './editor/chat.js';
import { mountEditorAddons } from './addons/registry.js';
import { createEditorProperties } from './editor/properties.js';
import { createEditorSource } from './editor/source.js';
import { mountEditorActions } from './editor/actions.js';
import { mountEditorSharing } from './editor/sharing.js';
export async function mount(scope) {
  const document = scope.document;

  const $ = (id) => document.getElementById(id);
  initTheme($('theme-toggle'));
  applyIcons();
  $('elements-tool').innerHTML = icon('elements');
  const projectId = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1));
  const base = '/api/projects/' + encodeURIComponent(projectId);
  const materialsUI = new MaterialsUI({
    base,
    input: $('materials-files'),
    drop: $('materials-drop'),
    list: $('materials-list'),
    status: $('materials-status'),
    button: $('materials-upload'),
  });
  $('materials-button').innerHTML = icon('attachment') + '<span>Материалы</span>';
  $('materials-button').addEventListener('click', async () => {
    $('materials-dialog').showModal();
    $('materials-description').hidden = !project?.description;
    $('materials-description').textContent = project?.description || '';
    try {
      await materialsUI.load();
    } catch (error) {
      $('materials-status').textContent = error.message;
    }
  });
  let project,
    current = 0;
  let projectLive, filmstripTimeline, authoringTools;
  let toastTimer;
  const histories = new Map();
  const canvas = new SlideCanvas({
    iframe: $('slide-canvas'),
    frame: $('slide-frame'),
    space: $('canvas-space'),
    selection: $('selection-layer'),
    callbacks: {
      onChange: (body) => onBodyChange(body),
      onSelection: (properties, context) => showProperties(properties, context),
      onAnnotation: (draft) => openAnnotation(draft),
      onScale: (scale) => {
        updateZoomControls(scale);
        renderPins();
      },
      onReady: () => {
        $('canvas-loading').hidden = true;
        scope.ready();
      },
      onSave: () => flushAll().catch((error) => toast(error.message, true)),
      onUndo: (redo) => undo(redo),
      onEscape: () => setTool('select'),
      onKey: handleKeys,
      onImagePlaceholder: (placeholder) => openImage(false, placeholder),
    },
  });
  const layersUI = new SlideLayers({
    parent: $('slide-layers'),
    getCanvas: () => canvas,
    onThemeEdit: openThemeEditor,
  });
  const activeSlide = () => project?.slides[current];
  const persistence = createEditorPersistence({
    base,
    getProject: () => project,
    getSlide: activeSlide,
    status,
    onError: (error) => toast(error.message, true),
  });
  const { dirtySlides, dirtyNotes, saveBodies, saveNotes, flushAll } = persistence;
  const chat = createEditorChat({
    base,
    getSlide: activeSlide,
    flush: flushAll,
    getSelectedAnnotation: () => annotations.selected,
    clearAnnotationContext: () => annotations.clearContext(),
    onRefresh: refreshAfterAgent,
    onError: (error) => toast(error.message, true),
    notify: toast,
  });
  const annotations = createEditorAnnotations({
    base,
    getProject: () => project,
    getSlide: activeSlide,
    getIndex: () => current,
    canvas,
    flush: flushAll,
    setTool,
    showSlide: (index) => showSlide(index),
    updateThumbnailComments: () => updateThumbnailComments(),
    chat,
    isAgentConfigured: () => chat.configured,
    onError: (error) => toast(error.message, true),
    notify: toast,
  });
  const navigation = createEditorNavigation({
    projectId,
    getProject: () => project,
    getSlide: activeSlide,
    getIndex: () => current,
    setIndex: (index) => {
      current = index;
    },
    getTimeline: () => filmstripTimeline,
    canvas,
    dirtyNotes,
    flush: flushAll,
    displaySlide: (slide) => presentationDesignUI.displaySlide(slide),
    displayProject,
    onBeforeSlide: () => closeAnnotation(),
    onAfterSlide: () => {
      renderPins();
      renderComments();
      updateUndo();
    },
    onSlideChange: () => presentationDesignUI.onSlideChange(),
    onError: (error) => toast(error.message, true),
  });
  const {
    showSlide,
    showSlideNow,
    renderFilmstrip,
    updateThumbnail,
    updateThumbnailComments,
    thumbnailNodes,
  } = navigation;
  function renderPins() {
    annotations.renderPins();
  }
  function renderComments() {
    annotations.renderComments();
  }
  function openAnnotation(value, existing) {
    annotations.open(value, existing);
  }
  function closeAnnotation() {
    annotations.close();
  }

  const presentationDesignUI = new PresentationDesignUI({
    base,
    getProject: () => project,
    getSlide: activeSlide,
    flush: flushAll,
    onError: (error) => toast(error.message, true),
    onSelectTab: setTab,
    onPreview: async () => {
      renderFilmstrip();
      await canvas.render(presentationDesignUI.displaySlide(activeSlide()), displayProject());
      renderPins();
    },
    onProject: async (snapshot, options = {}) => {
      const id = options.slideId || activeSlide().id;
      preserveLocalDrafts(project, snapshot, { dirtySlides, dirtyNotes });
      project = snapshot;
      $('project-name').textContent = project.title;
      document.title = project.title + ' · Kadlio';
      renderFilmstrip();
      await showSlide(
        Math.max(
          0,
          project.slides.findIndex((slide) => slide.id === id),
        ),
      );
      status(
        dirtySlides.size || dirtyNotes.size ? 'Есть изменения' : 'Сохранено',
        dirtySlides.size || dirtyNotes.size ? 'dirty' : '',
      );
    },
  });
  function displayProject() {
    return presentationDesignUI.displayProject(project);
  }

  filmstripTimeline = new FilmstripTimeline({
    list: $('slide-list'),
    base,
    getProject: () => project,
    flush: flushAll,
    canStart: () =>
      project &&
      !presentationDesignUI.dirty &&
      !annotations.draft &&
      !canvas.transformState &&
      !canvas.root?.querySelector('[contenteditable="true"]') &&
      !document.querySelector('dialog[open]'),
    onConfigure: (gapIndex) =>
      effectsUI.open({ gapIndex }).catch((error) => toast(error.message, true)),
    onBusy: setTimelineBusy,
    onProject: async (snapshot) => {
      const id = activeSlide().id;
      project = snapshot;
      current = Math.max(
        0,
        project.slides.findIndex((slide) => slide.id === id),
      );
      renderFilmstrip();
      await showSlideNow(current);
      status('Сохранено');
    },
    onError: (error) => toast(error.message, true),
  });
  const timelineControlStates = new Map();
  function setTimelineBusy(busy) {
    for (const id of [
      'add-slide',
      'slide-menu',
      'slide-prev',
      'slide-next',
      'select-tool',
      'blocks-tool',
      'elements-tool',
      'icons-tool',
      'effects-tool',
      'text-tool',
      'image-tool',
      'video-tool',
      'script-tool',
      'annotation-tool',
      'undo-button',
      'redo-button',
      'source-button',
    ]) {
      const control = $(id);
      if (busy) {
        if (!timelineControlStates.has(control))
          timelineControlStates.set(control, control.disabled);
        control.disabled = true;
      } else if (timelineControlStates.has(control)) {
        control.disabled = timelineControlStates.get(control);
        timelineControlStates.delete(control);
      }
    }
    $('canvas-space').inert = busy;
    $('properties-panel').inert = busy;
    $('notes-input').disabled = busy;
    if (!busy) {
      $('slide-prev').disabled = current === 0;
      $('slide-next').disabled = current === project.slides.length - 1;
      updateUndo();
      projectLive?.schedule(150);
    }
  }

  const addons = mountEditorAddons(
    {
      base,
      getCanvas: () => canvas,
      getProject: () => project,
      getSlide: activeSlide,
      flush: flushAll,
      onError: (error) => toast(error.message, true),
      onSelectTab: setTab,
    },
    {
      compositions: {
        onSlide: async (saved) => {
          const slide = project.slides.find((item) => item.id === saved.id);
          if (!slide) return;
          const existingIds = new Set(
            [...canvas.root.querySelectorAll('[data-block-id]')].map(
              (element) => element.dataset.blockId,
            ),
          );
          const history = historyFor(slide);
          history.past.push(slide.body);
          history.future = [];
          Object.assign(slide, saved);
          const index = project.slides.indexOf(slide);
          await showSlide(index);
          updateThumbnail(slide);
          setTool('select');
          canvas.select(
            [...canvas.root.querySelectorAll('[data-block-id]')].find(
              (element) => !existingIds.has(element.dataset.blockId),
            ) || null,
          );
          status('Сохранено');
        },
        onProject: async (snapshot, options = {}) => {
          const id = options.slideId || activeSlide().id;
          preserveLocalDrafts(project, snapshot, { dirtySlides, dirtyNotes });
          project = snapshot;
          $('project-name').textContent = project.title;
          document.title = project.title + ' · Kadlio';
          renderFilmstrip();
          await showSlide(
            Math.max(
              0,
              project.slides.findIndex((slide) => slide.id === id),
            ),
          );
          status(
            dirtySlides.size || dirtyNotes.size ? 'Есть изменения' : 'Сохранено',
            dirtySlides.size || dirtyNotes.size ? 'dirty' : '',
          );
        },
      },
      'design-elements': {
        parent: $('elements-catalog'),
        button: $('elements-tool'),
        base,
        getCanvas: () => canvas,
        getProject: displayProject,
        getSlide: activeSlide,
        flush: flushAll,
        onSlide: async (saved) => {
          const slide = project.slides.find((item) => item.id === saved.id);
          if (!slide) return;
          const body = slide.body,
            localNotes = slide.notes,
            localNotesVersion = slide.notesVersion,
            selectedTab = document
              .querySelector('.panel-tabs [aria-selected=true]')
              ?.id.replace('-tab', '');
          const existingIds = new Set(
            saved.id === activeSlide().id
              ? [...canvas.root.querySelectorAll('[data-block-id]')].map(
                  (element) => element.dataset.blockId,
                )
              : [],
          );
          if (dirtySlides.has(slide.id)) {
            toast(
              'Слайд изменился во время вставки. Сохраните свой HTML и обновите слайд для согласования.',
              true,
            );
            return;
          }
          historyFor(slide).past.push(body);
          historyFor(slide).future = [];
          Object.assign(slide, saved);
          if (dirtyNotes.has(slide.id)) {
            slide.notes = localNotes;
            slide.notesVersion = localNotesVersion;
          }
          updateThumbnail(slide);
          if (saved.id === activeSlide().id) {
            await canvas.render(presentationDesignUI.displaySlide(slide), displayProject());
            setTool('select');
            canvas.select(
              [...canvas.root.querySelectorAll('[data-block-id]')].find(
                (element) => !existingIds.has(element.dataset.blockId),
              ) || null,
            );
            if (selectedTab) setTab(selectedTab);
            updateUndo();
          }
          status(dirtyNotes.size ? 'Есть изменения' : 'Сохранено', dirtyNotes.size ? 'dirty' : '');
        },
        onGenerate: (options) =>
          chat.send(options.message, null, {
            explicitFiles: options.attachments || [],
            preserveComposer: true,
            onAccepted: options.onAccepted,
          }),
        onAccepted: () => {
          if (matchMedia('(max-width:950px)').matches) {
            $('chat-panel').classList.add('mobile-open');
            $('chat-toggle').setAttribute('aria-pressed', 'true');
            $('properties-panel').classList.remove('mobile-open');
            $('properties-toggle').setAttribute('aria-pressed', 'false');
          }
        },
        onError: (error) => toast(error.message, true),
      },
      icons: {
        parent: $('icons-catalog'),
        getCanvas: () => canvas,
        onInsert: () => {
          setTool('select');
          setTab('properties');
        },
        onError: (error) => toast(error.message, true),
      },
      motion: {
        button: $('effects-tool'),
        getProject: () => project,
        getSlide: activeSlide,
        getGap: () => Math.min(current, project.slides.length - 2),
        getTransition: (gap) => transitionForGap(project, gap),
        onApply: (effects, gap) => filmstripTimeline.apply(gap, effects),
        onCopy: (from, to) => filmstripTimeline.copy(from, to),
        onRemove: (gap) => filmstripTimeline.remove(gap),
        onEditSnippet: (options) =>
          authoringTools.openScript(options).catch((error) => toast(error.message, true)),
        onError: (error) => toast(error.message, true),
      },
    },
  );
  const elementsUI = addons['design-elements'],
    iconsUI = addons.icons,
    effectsUI = addons.motion;

  authoringTools = initializeAuthoringTools(mountAuthoringTools);
  function initializeAuthoringTools(mount) {
    return mount({
      base,
      getCanvas: () => canvas,
      getProject: () => project,
      getSlide: activeSlide,
      flush: flushAll,
      onSlide: async (saved) => {
        const slide = project.slides.find((item) => item.id === saved.id);
        if (!slide) return;
        const body = slide.body,
          notes = slide.notes,
          notesVersion = slide.notesVersion,
          isCurrent = slide.id === activeSlide().id,
          selected = canvas.selected,
          selectedId = selected?.dataset.blockId,
          ids = new Set(
            isCurrent
              ? [...canvas.root.querySelectorAll('[data-block-id]')].map(
                  (element) => element.dataset.blockId,
                )
              : [],
          );
        if (dirtySlides.has(slide.id) && saved.body !== body)
          throw new Error(
            'Слайд изменился во время запроса. Ваш HTML сохранён локально; согласуйте его с новой версией.',
          );
        if (saved.body !== body) {
          historyFor(slide).past.push(body);
          historyFor(slide).future = [];
        }
        Object.assign(slide, saved);
        if (dirtyNotes.has(slide.id)) {
          slide.notes = notes;
          slide.notesVersion = notesVersion;
        }
        updateThumbnail(slide);
        if (isCurrent) {
          await canvas.render(presentationDesignUI.displaySlide(slide), displayProject());
          canvas.select(
            [...canvas.root.querySelectorAll('[data-block-id]')].find(
              (element) => !ids.has(element.dataset.blockId),
            ) ||
              (selected?.isConnected && canvas.root.contains(selected)
                ? selected
                : [...canvas.root.querySelectorAll('[data-block-id]')].find(
                    (element) => element.dataset.blockId === selectedId,
                  )) ||
              null,
          );
          updateUndo();
        }
        status(
          dirtySlides.size || dirtyNotes.size ? 'Есть изменения' : 'Сохранено',
          dirtySlides.size || dirtyNotes.size ? 'dirty' : '',
        );
      },
      onProject: async (saved) => {
        const id = activeSlide().id;
        preserveLocalDrafts(project, saved, { dirtySlides, dirtyNotes });
        project = saved;
        renderFilmstrip();
        await showSlide(
          Math.max(
            0,
            project.slides.findIndex((slide) => slide.id === id),
          ),
        );
        presentationDesignUI.sync();
      },
      onError: (error) => toast(error.message, true),
    });
  }

  const propertiesUI = createEditorProperties({
    base,
    canvas,
    layersUI,
    setTab,
    setTool,
    flush: flushAll,
    openThemeEditor,
    showDialog,
  });
  const sourceUI = createEditorSource({
    getSlide: activeSlide,
    getIndex: () => current,
    canvas,
    displaySlide: (slide) => presentationDesignUI.displaySlide(slide),
    displayProject,
    onBodyChange,
    saveBodies,
    renderPins,
    showDialog,
  });
  mountEditorActions({
    base,
    getProject: () => project,
    setProject: (snapshot) => {
      project = snapshot;
    },
    getSlide: activeSlide,
    getIndex: () => current,
    flush: flushAll,
    renderFilmstrip,
    showSlide,
    showDialog,
    onError: (error) => toast(error.message, true),
  });
  mountEditorSharing({
    base,
    getProject: () => project,
    flush: flushAll,
    onRefresh: refreshSnapshot,
    chat,
    showDialog,
  });
  function showProperties(properties, context) {
    propertiesUI.show(properties, context);
  }
  function openImage(replace, placeholder) {
    propertiesUI.openImage(replace, placeholder);
  }
  async function openThemeEditor() {
    try {
      await presentationDesignUI.openDesign();
      await presentationDesignUI.editCopy();
    } catch (error) {
      toast(error.message, true);
    }
  }

  listen(document, 'presentations:authoring-idle', () => projectLive?.schedule(150));
  listen(document, 'presentations:variables-idle', () => projectLive?.schedule(150));

  function toast(message, error = false) {
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = pageTimeout(() => ($('toast').hidden = true), error ? 7000 : 3500);
  }
  function status(message, type = '') {
    $('save-status').textContent = message;
    $('save-status').title = message;
    $('save-status').className = 'save-status ' + type;
  }
  function showDialog(id) {
    $(id).showModal();
  }
  document
    .querySelectorAll('[data-close]')
    .forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('dialog').forEach((dialog) =>
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dialog.close();
      }
    }),
  );

  function historyFor(slide) {
    if (!histories.has(slide.id)) histories.set(slide.id, { past: [], future: [] });
    return histories.get(slide.id);
  }
  function onBodyChange(body, remember = true) {
    const slide = activeSlide();
    if (!slide || body === slide.body) return;
    if (remember) {
      const history = historyFor(slide);
      history.past.push(slide.body);
      if (history.past.length > 50) history.past.shift();
      history.future = [];
    }
    slide.body = body;
    layersUI.schedule();
    dirtySlides.add(slide.id);
    status('Есть изменения', 'dirty');
    updateUndo();
    updateThumbnail(slide);
    persistence.scheduleBodies();
  }
  function updateUndo() {
    const history = activeSlide() ? historyFor(activeSlide()) : { past: [], future: [] };
    $('undo-button').disabled = !history.past.length;
    $('redo-button').disabled = !history.future.length;
  }
  async function undo(redo = false) {
    const slide = activeSlide();
    if (!slide) return;
    const history = historyFor(slide),
      from = redo ? history.future : history.past,
      to = redo ? history.past : history.future;
    if (!from.length) return;
    to.push(slide.body);
    onBodyChange(from.pop(), false);
    await canvas.render(presentationDesignUI.displaySlide(slide), displayProject());
    updateUndo();
  }
  listen(window, 'beforeunload', (event) => {
    if (
      authoringTools?.hasDraft ||
      effectsUI.hasDraft ||
      dirtySlides.size ||
      dirtyNotes.size ||
      presentationDesignUI.dirty ||
      sourceUI.hasDraft
    ) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  function setTool(mode) {
    canvas.setMode(mode);
    $('select-tool').classList.toggle('active', mode === 'select');
    $('select-tool').setAttribute('aria-pressed', String(mode === 'select'));
    $('annotation-tool').classList.toggle('active', mode === 'annotation');
    $('annotation-tool').setAttribute('aria-pressed', String(mode === 'annotation'));
    if (mode === 'annotation') {
      setTab('comments');
      // Закрываем мобильные панели, чтобы они не перекрывали точку комментария.
      for (const panel of ['properties', 'chat']) {
        $(panel + '-panel').classList.remove('mobile-open');
        $(panel + '-toggle').setAttribute('aria-pressed', 'false');
      }
      toast('Нажмите на место слайда, к которому относится комментарий');
    } else closeAnnotation();
  }
  $('select-tool').addEventListener('click', () => setTool('select'));
  $('annotation-tool').addEventListener('click', () =>
    setTool(canvas.mode === 'annotation' ? 'select' : 'annotation'),
  );
  $('annotation-add').addEventListener('click', () => setTool('annotation'));
  function updateZoomControls(scale) {
    const automatic = canvas.scaleMode === 'auto';
    $('zoom-label').textContent = Math.round(scale * 100) + '%';
    $('zoom-label').title = automatic ? 'Автоматический масштаб по размеру окна' : 'Ручной масштаб';
    $('zoom-out').disabled = scale <= 0.1;
    $('zoom-in').disabled = scale >= 2;
    $('zoom-fit').disabled = automatic;
    $('zoom-fit').setAttribute('aria-pressed', String(automatic));
  }
  $('zoom-out').addEventListener('click', () => canvas.zoomBy(-0.1));
  $('zoom-in').addEventListener('click', () => canvas.zoomBy(0.1));
  $('zoom-fit').addEventListener('click', () => canvas.resetZoom());
  $('slide-prev').addEventListener('click', () =>
    showSlide(current - 1).catch((error) => toast(error.message, true)),
  );
  $('slide-next').addEventListener('click', () =>
    showSlide(current + 1).catch((error) => toast(error.message, true)),
  );
  $('undo-button').addEventListener('click', () => undo());
  $('redo-button').addEventListener('click', () => undo(true));

  function setTab(name, { reveal = false } = {}) {
    if (name === 'icons') iconsUI.open();
    if (name === 'elements') elementsUI.open().catch((error) => toast(error.message, true));
    for (const tab of ['properties', 'design', 'notes', 'comments', 'elements', 'icons']) {
      $(tab + '-tab').setAttribute('aria-selected', String(tab === name));
      $(tab + '-content').hidden = tab !== name;
    }
    document
      .querySelectorAll('[data-panel-target]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.panelTarget === name)),
      );
    if (reveal && matchMedia('(max-width:700px)').matches) {
      $('properties-panel').classList.add('mobile-open');
      $('properties-toggle').setAttribute('aria-pressed', 'true');
      $('chat-panel').classList.remove('mobile-open');
      $('chat-toggle').setAttribute('aria-pressed', 'false');
    }
  }
  for (const tab of ['properties', 'design', 'notes', 'comments', 'elements', 'icons'])
    $(tab + '-tab').addEventListener('click', () =>
      tab === 'comments' ? setTool('annotation') : setTab(tab),
    );
  document
    .querySelectorAll('[data-panel-target]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        button.dataset.panelTarget === 'comments'
          ? setTool('annotation')
          : setTab(button.dataset.panelTarget, { reveal: true }),
      ),
    );
  function liveBlocked() {
    return (
      authoringTools?.hasDraft ||
      effectsUI.hasDraft ||
      filmstripTimeline?.busy ||
      dirtySlides.size ||
      dirtyNotes.size ||
      presentationDesignUI.dirty ||
      annotations.draft ||
      canvas.transformState ||
      canvas.root?.querySelector('[contenteditable="true"]') ||
      $('source-dialog').open ||
      $('text-prompt-dialog').open
    );
  }
  async function refreshSnapshot() {
    if (liveBlocked()) return false;
    const latest = await request(base);
    latest.annotations ||= [];
    if (liveBlocked()) return false;
    if (JSON.stringify(latest) === JSON.stringify(project)) return true;
    const before = project,
      previous = activeSlide(),
      id = previous?.id;
    const allStyle =
      JSON.stringify([
        before.design,
        before.css,
        before.title,
        before.author,
        before.brand,
        before.slides.length,
      ]) !==
      JSON.stringify([
        latest.design,
        latest.css,
        latest.title,
        latest.author,
        latest.brand,
        latest.slides.length,
      ]);
    const visual = (slide) =>
      JSON.stringify([
        slide?.id,
        slide?.body,
        slide?.title,
        slide?.layout,
        slide?.section,
        slide?.effects,
      ]);
    const reordered =
      before.slides.map((slide) => slide.id).join() !==
      latest.slides.map((slide) => slide.id).join();
    project = latest;
    current = Math.max(
      0,
      project.slides.findIndex((slide) => slide.id === id),
    );
    for (const slide of project.slides) {
      const old = before.slides.find((item) => item.id === slide.id);
      if (old?.body !== slide.body) histories.delete(slide.id);
    }
    if (reordered) renderFilmstrip();
    else
      for (const slide of project.slides) {
        const old = before.slides.find((item) => item.id === slide.id);
        if (allStyle || visual(old) !== visual(slide)) updateThumbnail(slide);
        const button = [...document.querySelectorAll('.slide-thumbnail')].find(
          (item) => item.dataset.slideId === slide.id,
        );
        if (button) {
          button.title = slide.title;
          button.querySelector('.thumb-label').textContent = slide.title;
        }
      }
    if (!reordered && JSON.stringify(before.timeline) !== JSON.stringify(project.timeline))
      filmstripTimeline.render(thumbnailNodes);
    if (allStyle || visual(previous) !== visual(activeSlide()) || reordered)
      await showSlide(current);
    else {
      $('notes-input').value = activeSlide().notes || '';
      renderPins();
      renderComments();
      updateUndo();
    }
    updateThumbnailComments();
    $('project-name').textContent = project.title;
    document.title = project.title + ' · Kadlio';
    presentationDesignUI.sync();
    return true;
  }
  async function refreshAfterAgent() {
    if (!(await refreshSnapshot())) projectLive?.schedule(150);
  }
  for (const name of ['chat', 'properties'])
    $(name + '-toggle').addEventListener('click', () => {
      const open = $(name + '-panel').classList.toggle('mobile-open');
      $(name + '-toggle').setAttribute('aria-pressed', String(open));
      if (open) {
        const other = name === 'chat' ? 'properties' : 'chat';
        $(other + '-panel').classList.remove('mobile-open');
        $(other + '-toggle').setAttribute('aria-pressed', 'false');
      }
    });
  function handleKeys(event) {
    if (filmstripTimeline?.busy) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      if ($('source-dialog').open)
        $('source-form').requestSubmit($('source-form').querySelector('button[type=submit]'));
      else flushAll().catch((error) => toast(error.message, true));
      return;
    }
    if (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
      event.target.isContentEditable ||
      document.querySelector('dialog[open]')
    )
      return;
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      undo(event.shiftKey);
    } else if (key === 'arrowleft') {
      event.preventDefault();
      showSlide(current - 1).catch((error) => toast(error.message, true));
    } else if (key === 'arrowright') {
      event.preventDefault();
      showSlide(current + 1).catch((error) => toast(error.message, true));
    } else if (key === 'a' || key === 'ф') {
      event.preventDefault();
      setTool('annotation');
    } else if (key === 'v' || key === 'м') {
      event.preventDefault();
      setTool('select');
    } else if (key === 'escape') {
      setTool('select');
      canvas.select(null);
    }
  }
  listen(document, 'keydown', handleKeys);
  listen(window, 'hashchange', () => {
    if (!project) return;
    const index = project.slides.findIndex(
      (slide) => slide.id === decodeURIComponent(location.hash.slice(1)),
    );
    if (index >= 0 && index !== current)
      showSlide(index).catch((error) => toast(error.message, true));
  });
  try {
    [project, chat.settings] = await Promise.all([request(base), request('/api/ai/settings')]);
    project.annotations ||= [];
    $('project-name').textContent = project.title;
    $('project-name').title = project.title + ' · Переименовать';
    document.title = project.title + ' · Kadlio';
    chat.renderSettings();
    renderFilmstrip();
    const selected = project.slides.findIndex(
      (slide) => slide.id === decodeURIComponent(location.hash.slice(1)),
    );
    await Promise.all([showSlide(selected < 0 ? 0 : selected), chat.loadHistory()]);
    if (new URLSearchParams(location.search).has('connect-ai')) await chat.openSettings();
    status('Сохранено');
    projectLive = new ProjectLive({
      url: base + '/events',
      isBlocked: liveBlocked,
      onRefresh: refreshSnapshot,
      onError: () => {},
    });
  } catch (error) {
    chat.failLoading(error);
    $('canvas-loading').textContent = error.message;
    status('Не удалось открыть', 'error');
    toast(error.message, true);
  }

  listen(window, 'pagehide', () => projectLive?.close());
}
