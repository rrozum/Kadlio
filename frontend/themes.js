import { navigate } from './modules/navigation.js';
import { request, escapeHTML } from './modules/api.js';
import { mountThemePreview } from './modules/theme-preview.js';
import { initTheme } from './modules/theme.js';
import { applyIcons } from './modules/icons.js';
export async function mount(scope) {
  const document = scope.document;

  const $ = (id) => document.getElementById(id);
  initTheme($('theme-toggle'));
  applyIcons();
  let themes = [],
    deleting;
  const cards = new Map(),
    disposers = new Map(),
    deletePending = new Set();
  function render() {
    const query = $('theme-search').value.trim().toLocaleLowerCase('ru');
    $('theme-count').textContent = themes.length + ' тем';
    let visible = 0;
    for (const theme of themes) {
      const matches = theme.title.toLocaleLowerCase('ru').includes(query);
      if (matches) visible++;
      const existing = cards.get(theme.id);
      if (existing) {
        existing.hidden = !matches;
        continue;
      }
      const card = document.createElement('article');
      card.className = 'project-card theme-card';
      card.dataset.themeId = theme.id;
      card.hidden = !matches;
      card.innerHTML =
        '<a href="/themes/' +
        encodeURIComponent(theme.id) +
        '"><div class="project-cover"></div><div class="project-description"><h2>' +
        escapeHTML(theme.title) +
        '</h2><div class="project-meta"><span>' +
        (theme.builtin ? 'Встроенная · можно создать копию' : 'Ваша тема') +
        '</span><span class="project-open">Редактировать ↗</span></div></div></a>';
      if (!theme.builtin) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'theme-delete project-delete';
        button.textContent = '×';
        button.setAttribute('aria-label', 'Удалить тему ' + theme.title);
        button.title = 'Удалить тему';
        button.addEventListener('click', () => {
          deleting = theme;
          $('delete-theme-description').textContent =
            '«' + theme.title + '» будет удалена из библиотеки.';
          $('delete-theme-status').textContent = '';
          $('delete-theme-form').querySelector('button[type=submit]').disabled = deletePending.has(
            theme.id,
          );
          $('delete-theme-dialog').showModal();
        });
        card.append(button);
      }
      $('themes-list').append(card);
      disposers.set(theme.id, mountThemePreview(card.querySelector('.project-cover'), theme));
      cards.set(theme.id, card);
    }
    for (const [id, card] of cards)
      if (!themes.some((theme) => theme.id === id)) {
        disposers.get(id)?.();
        disposers.delete(id);
        card.remove();
        cards.delete(id);
        $('new-theme-base')
          .querySelector('option[value="' + CSS.escape(id) + '"]')
          ?.remove();
      }
    let empty = $('themes-list').querySelector('.search-empty');
    if (!empty) {
      empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = 'По этому названию ничего не найдено.';
      $('themes-list').append(empty);
    }
    empty.hidden = !!visible;
  }
  $('theme-search').addEventListener('input', render);
  $('new-theme').addEventListener('click', () => {
    $('new-theme-status').textContent = '';
    $('new-theme-title').value = '';
    $('new-theme-dialog').showModal();
    $('new-theme-title').focus();
  });
  document
    .querySelectorAll('[data-close]')
    .forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('new-theme-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const theme = await request('/api/themes', {
        method: 'POST',
        body: { title: $('new-theme-title').value.trim(), baseThemeId: $('new-theme-base').value },
      });
      navigate('/themes/' + encodeURIComponent(theme.id));
    } catch (error) {
      $('new-theme-status').textContent = error.message;
      event.submitter.disabled = false;
    }
  });
  $('delete-theme-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!deleting || deletePending.has(deleting.id)) return;
    const target = deleting;
    deletePending.add(target.id);
    event.submitter.disabled = true;
    try {
      await request('/api/themes/' + encodeURIComponent(target.id), {
        method: 'DELETE',
        body: { version: target.version },
      });
      themes = themes.filter((theme) => theme.id !== target.id);
      if (deleting === target) {
        $('delete-theme-dialog').close();
        deleting = null;
      }
      render();
    } catch (error) {
      if (deleting === target) $('delete-theme-status').textContent = error.message;
    } finally {
      deletePending.delete(target.id);
      event.submitter.disabled = deletePending.has(deleting?.id);
    }
  });
  try {
    themes = (await request('/api/themes')).themes;
    $('themes-list').querySelector('.projects-loading')?.remove();
    for (const item of themes) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      $('new-theme-base').append(option);
    }
    render();
  } catch (error) {
    $('themes-list').replaceChildren();
    $('themes-status').textContent = error.message;
  }
}
