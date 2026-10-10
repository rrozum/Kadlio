import { listen } from './page-lifecycle.js';
import { request } from './api.js';
import { ShareSettings } from './share-settings.js';

export class ProjectActions {
  constructor({ onCopy, onDelete, onError }) {
    this.shareSettings = new ShareSettings({
      dialog: document.getElementById('gallery-share-dialog'),
      getId: () => this.shareId,
    });
    Object.assign(this, { onCopy, onDelete, onError });
    this.menu = document.getElementById('project-menu');
    this.menu.addEventListener('toggle', (event) => {
      if (event.newState === 'closed') this.trigger?.setAttribute('aria-expanded', 'false');
    });
    this.menu.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...this.menu.querySelectorAll('[role=menuitem]')],
        index = items.indexOf(document.activeElement),
        next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    });
    for (const action of ['share', 'copy', 'delete'])
      document.getElementById('project-menu-' + action).addEventListener('click', () => {
        const project = this.project,
          trigger = this.trigger;
        this.menu.hidePopover();
        if (action === 'delete') onDelete(project);
        else if (action === 'share') this.share(project);
        else this.copy(project, trigger);
      });
    listen(window, 'resize', () => this.menu.hidePopover());
    document
      .getElementById('gallery-share-create')
      .addEventListener('click', () => this.createShare());
    document.getElementById('gallery-share-dialog').addEventListener('close', () => {
      this.shareEpoch = (this.shareEpoch || 0) + 1;
    });
    document.getElementById('gallery-share-copy').addEventListener('click', async () => {
      const input = document.getElementById('gallery-share-url'),
        status = document.getElementById('gallery-share-status');
      try {
        await navigator.clipboard.writeText(input.value);
        status.textContent = 'Ссылка скопирована';
      } catch {
        input.select();
        status.textContent = 'Скопируйте выделенную ссылку';
      }
    });
    document.getElementById('gallery-share-revoke').addEventListener('click', async () => {
      const id = this.shareId,
        epoch = this.shareEpoch;
      if (!confirm('Отключить публичную ссылку?')) return;
      const button = document.getElementById('gallery-share-revoke');
      button.disabled = true;
      try {
        await request('/api/projects/' + id + '/share', { method: 'DELETE' });
        if (this.shareEpoch === epoch) {
          this.shareState(null);
          document.getElementById('gallery-share-status').textContent = 'Ссылка отключена';
        }
      } catch (error) {
        if (this.shareEpoch === epoch)
          document.getElementById('gallery-share-status').textContent = error.message;
      } finally {
        if (this.shareEpoch === epoch) button.disabled = false;
      }
    });
  }
  open(project, trigger) {
    if (this.menu.matches(':popover-open')) {
      const same = this.trigger === trigger;
      this.menu.hidePopover();
      if (same) return;
    }
    this.project = project;
    this.trigger = trigger;
    const creating = project.creationMode === 'smart' && project.creation?.status !== 'ready';
    document.getElementById('project-menu-open').href = creating
      ? '/projects/new?project=' + project.id
      : '/projects/' + project.id;
    this.menu.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = trigger.getBoundingClientRect(),
      width = this.menu.offsetWidth,
      height = this.menu.offsetHeight;
    this.menu.style.left =
      Math.max(8, Math.min(innerWidth - width - 8, bounds.right - width)) + 'px';
    this.menu.style.top =
      (bounds.bottom + height + 12 > innerHeight
        ? Math.max(8, bounds.top - height - 6)
        : bounds.bottom + 6) + 'px';
    this.menu.querySelector('[role=menuitem]').focus();
  }
  async copy(project, trigger) {
    trigger.disabled = true;
    try {
      const current = await request('/api/projects/' + project.id),
        copy = await request('/api/projects/' + project.id + '/copy', {
          method: 'POST',
          body: { version: current.version },
        });
      this.onCopy(copy);
    } catch (error) {
      this.onError(error);
    } finally {
      trigger.disabled = false;
    }
  }
  shareState(url) {
    document.getElementById('gallery-share-active').hidden = !url;
    document.getElementById('gallery-share-inactive').hidden = !!url;
    if (url) {
      document.getElementById('gallery-share-url').value = url;
      document.getElementById('gallery-share-open').href = url;
    }
  }
  async share(project) {
    this.shareId = project.id;
    const epoch = (this.shareEpoch = (this.shareEpoch || 0) + 1),
      dialog = document.getElementById('gallery-share-dialog'),
      status = document.getElementById('gallery-share-status'),
      button = document.getElementById('gallery-share-create');
    this.shareState(null);
    status.textContent = 'Загружаем ссылку…';
    button.disabled = true;
    document.getElementById('gallery-share-revoke').disabled = false;
    dialog.showModal();
    try {
      const current = await request('/api/projects/' + project.id);
      if (this.shareEpoch === epoch && dialog.open) {
        this.shareState(current.shareUrl || null);
        status.textContent = '';
      }
    } catch (error) {
      if (this.shareEpoch === epoch) status.textContent = error.message;
    } finally {
      if (this.shareEpoch === epoch) button.disabled = false;
    }
  }
  async createShare() {
    const id = this.shareId,
      epoch = this.shareEpoch,
      button = document.getElementById('gallery-share-create');
    button.disabled = true;
    try {
      const { url } = await request('/api/projects/' + id + '/share', { method: 'POST' });
      if (this.shareEpoch === epoch) this.shareState(url);
    } catch (error) {
      if (this.shareEpoch === epoch)
        document.getElementById('gallery-share-status').textContent = error.message;
    } finally {
      if (this.shareEpoch === epoch) button.disabled = false;
    }
  }
}
