import { mountPreviewFrame } from './modules/preview-frame.js';
import { navigate } from './modules/navigation.js';
import { PageIntersectionObserver } from './modules/page-lifecycle.js';
import { request, escapeHTML } from './modules/api.js';
import { slideDocument } from './engine/slide.js';
import { initTheme } from './modules/theme.js';
import { applyIcons } from './modules/icons.js';
import { ProjectActions } from './modules/project-actions.js';
export async function mount(scope) {
  const document = scope.document;

  const $ = (id) => document.getElementById(id);
  initTheme($('theme-toggle'));
  applyIcons();
  let projects = [],
    deleting = null;
  const deletePending = new Set();
  const actions = new ProjectActions({
    onDelete: (project) => {
      deleting = project;
      $('delete-description').textContent = project.title;
      $('delete-status').textContent = '';
      $('delete-form').querySelector('button[type=submit]').disabled = deletePending.has(
        project.id,
      );
      $('delete-dialog').showModal();
    },
    onCopy: (copy) => {
      projects.unshift({ ...copy, slideCount: copy.slides.length });
      renderProjects();
      projectCards.get(copy.id)?.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    onError: (error) => ($('projects-error').textContent = error.message),
  });
  const previews = new Map(),
    projectCards = new Map();
  const lazyPreviews = new PageIntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazyPreviews.unobserve(entry.target);
        const record = projectCards.get(entry.target.dataset.projectId);
        if (record)
          loadPreview(record.project, record.card.querySelector('.project-cover'), record);
      }
    },
    { rootMargin: '240px' },
  );

  function openCreate() {
    navigate('/projects/new');
  }
  $('new-project').addEventListener('click', openCreate);
  $('first-project').addEventListener('click', openCreate);
  let importing = false;
  $('import-pptx').addEventListener('click', () => {
    if (importing) return;
    $('pptx-import-status').textContent = '';
    $('pptx-import-status').classList.remove('error');
    $('pptx-import-result').hidden = true;
    $('pptx-import-submit').hidden = false;
    $('pptx-import-dialog').showModal();
  });
  $('pptx-import-dialog').addEventListener('cancel', (event) => {
    if (importing) event.preventDefault();
  });
  $('pptx-import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (importing) return;
    const file = $('pptx-import-file').files[0],
      title = $('pptx-import-title').value.trim();
    if (!file || !file.name.toLowerCase().endsWith('.pptx') || file.size > 8 * 1024 * 1024) {
      $('pptx-import-status').textContent = 'Выберите файл .pptx до 8 МБ.';
      return;
    }
    importing = true;
    const controls = [...$('pptx-import-form').querySelectorAll('input,button')];
    controls.forEach((control) => (control.disabled = true));
    $('pptx-import-status').classList.remove('error');
    $('pptx-import-status').textContent = 'Разбираем слайды и переносим блоки…';
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        reader.readAsDataURL(file);
      });
      const imported = await request('/api/projects/import-pptx', {
        method: 'POST',
        body: {
          name: file.name,
          mime: file.type,
          data,
          ...(title ? { title } : {}),
          includeHidden: $('pptx-import-hidden').checked,
        },
      });
      projects.unshift({ ...imported, slideCount: imported.slides.length });
      renderProjects();
      $('pptx-import-summary').textContent =
        'Импортировано слайдов: ' + imported.slides.length + '. Оригинал сохранён.';
      $('pptx-import-warnings').replaceChildren(
        ...(imported.importReport?.warnings || []).map((message) => {
          const item = document.createElement('li');
          item.textContent = message;
          return item;
        }),
      );
      $('pptx-import-open').href = '/projects/' + encodeURIComponent(imported.id);
      $('pptx-import-result').hidden = false;
      $('pptx-import-submit').hidden = true;
      $('pptx-import-status').textContent = 'Готово';
    } catch (error) {
      $('pptx-import-status').classList.add('error');
      $('pptx-import-status').textContent = error.message;
    } finally {
      importing = false;
      controls.forEach((control) => (control.disabled = false));
    }
  });
  document
    .querySelectorAll('[data-close]')
    .forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('project-search').addEventListener('input', renderProjects);
  $('delete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!deleting || deletePending.has(deleting.id)) return;
    const target = deleting;
    deletePending.add(target.id);
    event.submitter.disabled = true;
    try {
      const url = '/api/projects/' + encodeURIComponent(target.id),
        current = await request(url);
      await request(url, { method: 'DELETE', body: { version: current.version } });
      projects = projects.filter((project) => project.id !== target.id);
      if (deleting === target) {
        $('delete-dialog').close();
        deleting = null;
      }
      renderProjects();
    } catch (error) {
      if (deleting === target) $('delete-status').textContent = error.message;
    } finally {
      deletePending.delete(target.id);
      event.submitter.disabled = deletePending.has(deleting?.id);
    }
  });

  function renderProjects() {
    const query = $('project-search').value.trim().toLocaleLowerCase('ru');
    const visible = projects.filter((project) =>
      project.title.toLocaleLowerCase('ru').includes(query),
    );
    $('project-count').textContent =
      projects.length +
      ' ' +
      (projects.length === 1
        ? 'проект'
        : projects.length > 1 && projects.length < 5
          ? 'проекта'
          : 'проектов');
    $('projects-empty').hidden = projects.length > 0;
    for (const [id, record] of projectCards)
      if (!projects.some((project) => project.id === id)) {
        record.dispose?.();
        lazyPreviews.unobserve(record.card);
        record.card.remove();
        projectCards.delete(id);
        previews.delete(id);
      }
    let empty = $('projects-list').querySelector('.search-empty');
    if (!empty) {
      empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = 'По этому названию ничего не найдено.';
      $('projects-list').append(empty);
    }
    empty.hidden = !!visible.length || !projects.length;
    for (const project of projects) {
      const existing = projectCards.get(project.id);
      if (existing) {
        existing.card.hidden = !visible.includes(project);
        continue;
      }
      const card = document.createElement('article');
      card.className = 'project-card';
      card.dataset.projectId = project.id;
      card.hidden = !visible.includes(project);
      const creating = project.creationMode === 'smart' && project.creation?.status !== 'ready';
      const updated = project.updatedAt
        ? new Date(project.updatedAt).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
          })
        : '';
      card.innerHTML = `<a href="${creating ? '/projects/new?project=' + encodeURIComponent(project.id) : '/projects/' + encodeURIComponent(project.id)}"><div class="project-cover" aria-busy="true"><div class="preview-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>Загружаем превью</span></div></div><div class="project-description"><h2>${escapeHTML(project.title)}</h2><div class="project-meta"><span>${project.slideCount || 0} слайдов${updated ? ' · ' + escapeHTML(updated) : ''}</span><span class="project-open">${creating ? 'Продолжить создание' : 'Открыть'} ↗</span></div></div></a><button class="project-delete" aria-label="Удалить ${escapeHTML(project.title)}" title="Удалить презентацию">⋯</button>`;
      const menu = card.querySelector('.project-delete');
      menu.classList.add('project-menu-trigger');
      menu.setAttribute('aria-label', 'Действия с презентацией ' + project.title);
      menu.title = 'Действия с презентацией';
      menu.setAttribute('aria-haspopup', 'menu');
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-controls', 'project-menu');
      menu.addEventListener('click', () => actions.open(project, menu));
      $('projects-list').append(card);
      projectCards.set(project.id, { card, project });
      lazyPreviews.observe(card);
    }
  }
  async function loadPreview(project, cover, record) {
    try {
      if (!previews.has(project.id))
        previews.set(project.id, request('/api/projects/' + encodeURIComponent(project.id)));
      const snapshot = await previews.get(project.id);
      if (!cover.isConnected) return;
      if (!snapshot.slides?.[0]) {
        cover.querySelector('.preview-loading')?.replaceChildren('Пока нет слайдов');
        cover.setAttribute('aria-busy', 'false');
        return;
      }
      record.dispose = mountPreviewFrame(cover, {
        title: 'Первый слайд: ' + project.title,
        html: slideDocument(snapshot.slides[0], snapshot),
      });
    } catch {
      if (cover.isConnected) {
        cover.querySelector('.preview-loading')?.replaceChildren('Превью недоступно');
        cover.setAttribute('aria-busy', 'false');
      }
      previews.delete(project.id);
    }
  }
  try {
    const result = await request('/api/projects');
    projects = result.projects;
    $('projects-list').querySelector('.projects-loading')?.remove();
    renderProjects();
  } catch (error) {
    $('projects-list').replaceChildren();
    $('projects-error').textContent = error.message;
  }
}
