import { listen } from './page-lifecycle.js';
import { request } from './api.js';
import {
  normalizeTimeline,
  timelineForOrder,
  transitionForGap,
} from '../../shared/presentation/timeline.js';
import { effectPresets } from '../../shared/addons/motion/runtime.js';

const signature = (project) => JSON.stringify(normalizeTimeline(project));
const name = (preset) => effectPresets.find((item) => item.id === preset)?.name || 'Переход';
const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

// Жест перемещает существующие миниатюры и сохраняет документы iframe. Порядок
// DOM меняется после сохранения timeline; при ошибке остаётся прежний порядок.
export class FilmstripTimeline {
  constructor({
    list,
    base,
    getProject,
    canStart,
    flush,
    onProject,
    onBusy,
    onConfigure,
    onError,
  }) {
    Object.assign(this, {
      list,
      base,
      getProject,
      canStart,
      flush,
      onProject,
      onBusy,
      onConfigure,
      onError,
    });
    this.gaps = new Map();
    this.marker = document.createElement('span');
    this.marker.className = 'timeline-drop-marker';
    this.marker.hidden = true;
    this.marker.setAttribute('aria-hidden', 'true');
    list.append(this.marker);
    this.status = document.createElement('span');
    this.status.className = 'timeline-status';
    this.status.setAttribute('role', 'status');
    list.before(this.status);
    list.addEventListener('pointerdown', (event) => this.start(event));
    listen(window, 'pointermove', (event) => this.move(event), { passive: false });
    listen(window, 'pointerup', (event) => this.finish(event).catch(() => {}));
    list.addEventListener('pointercancel', () => this.cancel());
    list.addEventListener('lostpointercapture', () => {
      if (this.gesture) this.cancel();
    });
    list.addEventListener(
      'click',
      (event) => {
        if (this.pending || performance.now() < (this.suppressClickUntil || 0)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    list.addEventListener('dragstart', (event) => event.preventDefault());
    listen(window, 'keydown', (event) => {
      if (event.key === 'Escape' && this.gesture) {
        event.preventDefault();
        this.cancel();
      }
    });
  }
  get busy() {
    return !!this.pending || !!this.gesture?.dragging;
  }
  render(slideNodes) {
    const project = this.getProject();
    if (!project) return;
    if (!this.pending) this.status.textContent = '';
    const ordered = [];
    for (const [index, slide] of project.slides.entries()) {
      ordered.push(slideNodes.get(slide.id));
      if (index === project.slides.length - 1) continue;
      let gap = this.gaps.get(index);
      if (!gap) {
        gap = document.createElement('button');
        gap.type = 'button';
        gap.dataset.gapIndex = index;
        gap.addEventListener('click', () => this.onConfigure(index));
        this.gaps.set(index, gap);
      }
      const transition = transitionForGap(project, index);
      gap.className = transition ? 'transition-card' : 'transition-gap';
      gap.dataset.gapIndex = index;
      if (transition) {
        gap.dataset.transitionId = transition.id;
        gap.innerHTML =
          '<span class="transition-symbol" aria-hidden="true">⇄</span><span class="transition-name"></span><span class="transition-duration"></span>';
        gap.querySelector('.transition-name').textContent = transition.snippet
          ? 'JS-переход'
          : name(transition.preset);
        gap.querySelector('.transition-duration').textContent = transition.duration / 1000 + ' с';
        gap.title =
          'Настроить переход · ' + (transition.snippet ? 'JS-переход' : name(transition.preset));
        gap.setAttribute(
          'aria-label',
          (transition.snippet ? 'JS-переход' : name(transition.preset)) +
            ' между слайдами ' +
            (index + 1) +
            ' и ' +
            (index + 2),
        );
      } else {
        delete gap.dataset.transitionId;
        gap.textContent = '+';
        gap.title = 'Добавить переход';
        gap.setAttribute(
          'aria-label',
          'Добавить переход между слайдами ' + (index + 1) + ' и ' + (index + 2),
        );
      }
      ordered.push(gap);
    }
    for (const [index, gap] of this.gaps)
      if (index >= project.slides.length - 1) {
        gap.remove();
        this.gaps.delete(index);
      }
    let cursor = this.list.firstElementChild;
    for (const node of ordered) {
      if (node !== cursor) {
        if (node.parentNode === this.list && this.list.moveBefore)
          this.list.moveBefore(node, cursor);
        else {
          const iframe = node.querySelector('iframe');
          if (iframe) iframe.renderMarkup = null;
          this.list.insertBefore(node, cursor);
        }
      }
      cursor = node.nextElementSibling;
    }
    this.list.append(this.marker);
  }
  start(event) {
    if (!this.pending) this.suppressClickUntil = 0;
    if (event.button !== 0 || this.busy || !this.canStart?.()) return;
    const node = event.target.closest(
      '.slide-thumbnail[data-slide-id],.transition-card[data-transition-id]',
    );
    if (!node || node.parentNode !== this.list) return;
    this.gesture = {
      node,
      id: node.dataset.slideId || node.dataset.transitionId,
      type: node.dataset.slideId ? 'slide' : 'transition',
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      scroll: this.list.scrollLeft,
      original: signature(this.getProject()),
      dragging: false,
    };
  }
  move(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6)
      return;
    if (!gesture.dragging) {
      this.list.setPointerCapture(event.pointerId);
      gesture.dragging = true;
      gesture.node.classList.add('timeline-dragging');
      gesture.node.setAttribute('aria-grabbed', 'true');
      this.list.classList.add('timeline-drag-active');
      this.onBusy?.(true);
      this.autoScroll();
    }
    event.preventDefault();
    this.position();
  }
  position() {
    const gesture = this.gesture;
    if (!gesture?.dragging) return;
    gesture.node.style.translate =
      gesture.lastX -
      gesture.x +
      this.list.scrollLeft -
      gesture.scroll +
      'px ' +
      (gesture.lastY - gesture.y) +
      'px';
    const bounds = this.list.getBoundingClientRect();
    const outside =
      gesture.lastY < bounds.top - 30 ||
      gesture.lastY > bounds.bottom + 30 ||
      gesture.lastX < bounds.left - 45 ||
      gesture.lastX > bounds.right + 45;
    this.list.querySelector('.timeline-drop-target')?.classList.remove('timeline-drop-target');
    this.marker.hidden = true;
    gesture.target = null;
    if (outside) return;
    if (gesture.type === 'slide') {
      const others = [...this.list.querySelectorAll('.slide-thumbnail')].filter(
        (node) => node !== gesture.node,
      );
      const index = others.findIndex(
        (node) =>
          gesture.lastX <
          node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2,
      );
      gesture.target = index < 0 ? others.length : index;
      const after = others[gesture.target],
        before = others[gesture.target - 1];
      const x = after
        ? after.getBoundingClientRect().left
        : before
          ? before.getBoundingClientRect().right
          : bounds.left;
      this.marker.style.left = x - bounds.left + this.list.scrollLeft - 3 + 'px';
      this.marker.hidden = false;
    } else {
      const gaps = [...this.gaps.values()];
      const target = gaps.reduce((best, node) => {
        const rect = node.getBoundingClientRect(),
          translation =
            node === gesture.node
              ? gesture.lastX - gesture.x + this.list.scrollLeft - gesture.scroll
              : 0,
          distance = Math.abs(gesture.lastX - (rect.left - translation) - rect.width / 2);
        return !best || distance < best.distance ? { node, distance } : best;
      }, null);
      if (target) {
        gesture.target = Number(target.node.dataset.gapIndex);
        target.node.classList.add('timeline-drop-target');
      }
    }
  }
  autoScroll() {
    const tick = () => {
      const gesture = this.gesture;
      if (!gesture?.dragging) return;
      const bounds = this.list.getBoundingClientRect();
      let step = 0;
      if (gesture.lastX < bounds.left + 45)
        step = -Math.min(14, (bounds.left + 45 - gesture.lastX) / 4);
      else if (gesture.lastX > bounds.right - 45)
        step = Math.min(14, (gesture.lastX - bounds.right + 45) / 4);
      if (step) {
        this.list.scrollLeft += step;
        this.position();
      }
      this.scrollFrame = requestAnimationFrame(tick);
    };
    this.scrollFrame = requestAnimationFrame(tick);
  }
  cleanup() {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    cancelAnimationFrame(this.scrollFrame);
    gesture.node.classList.remove('timeline-dragging');
    gesture.node.style.translate = '';
    gesture.node.removeAttribute('aria-grabbed');
    this.list.classList.remove('timeline-drag-active');
    this.list.querySelector('.timeline-drop-target')?.classList.remove('timeline-drop-target');
    this.marker.hidden = true;
    if (this.list.hasPointerCapture(gesture.pointer))
      this.list.releasePointerCapture(gesture.pointer);
    if (gesture.dragging) this.suppressClickUntil = performance.now() + 350;
  }
  cancel() {
    const dragged = this.gesture?.dragging;
    this.cleanup();
    if (dragged) this.onBusy?.(false);
  }
  async finish(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const { dragging, target, id, type, original } = gesture;
    this.cleanup();
    if (!dragging) return;
    if (target === null) {
      this.onBusy?.(false);
      return;
    }
    const source = this.getProject(),
      ids = source.slides.map((slide) => slide.id);
    if (type === 'slide') {
      const next = ids.filter((value) => value !== id);
      next.splice(target, 0, id);
      if (sameOrder(ids, next)) {
        this.onBusy?.(false);
        return;
      }
      await this.mutate((project) => timelineForOrder(project, next), original);
    } else
      await this.mutate((project) => {
        const from = project.slides.findIndex(
          (_, index) => transitionForGap(project, index)?.id === id,
        );
        if (from === target) return normalizeTimeline(project);
        const gaps = project.slides
          .slice(0, -1)
          .map((_, index) => transitionForGap(project, index));
        [gaps[from], gaps[target]] = [gaps[target], gaps[from]];
        return project.slides.flatMap((slide, index) =>
          gaps[index]
            ? [{ type: 'slide', id: slide.id }, gaps[index]]
            : [{ type: 'slide', id: slide.id }],
        );
      }, original);
  }
  async mutate(build, expected = signature(this.getProject())) {
    if (this.pending) return;
    this.pending = true;
    this.list.classList.add('timeline-saving');
    this.list.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Сохраняем порядок…';
    this.onBusy?.(true);
    try {
      await this.flush();
      const latest = await request(this.base);
      if (signature(latest) !== expected)
        throw new Error(
          'Порядок изменился в другом окне или агентом. Обновите ленту и повторите действие.',
        );
      const timeline = build(latest);
      if (JSON.stringify(timeline) === signature(latest)) return latest;
      const saved = await request(this.base + '/timeline', {
        method: 'PATCH',
        body: { timeline, version: latest.version },
      });
      await this.onProject(saved);
      this.status.textContent = 'Порядок сохранён';
      return saved;
    } catch (error) {
      this.status.textContent = 'Порядок не изменён';
      this.onError?.(error);
      throw error;
    } finally {
      this.pending = false;
      this.list.classList.remove('timeline-saving');
      this.list.removeAttribute('aria-busy');
      this.onBusy?.(false);
    }
  }
  async apply(gapIndex, effects) {
    return this.mutate((project) => {
      const transition = transitionForGap(project, gapIndex);
      const replacement =
        effects.preset === 'none'
          ? null
          : { type: 'transition', id: transition?.id || crypto.randomUUID(), ...effects };
      return this.withGap(project, gapIndex, replacement);
    });
  }
  async remove(gapIndex) {
    return this.mutate((project) => this.withGap(project, gapIndex, null));
  }
  async copy(from, to) {
    return this.mutate((project) => {
      if (transitionForGap(project, to))
        throw new Error('Этот промежуток уже занят. Выберите свободное место для копии.');
      const transition = transitionForGap(project, from);
      if (!transition) throw new Error('Переход уже удалён.');
      return this.withGap(project, to, { ...transition, id: crypto.randomUUID() });
    });
  }
  withGap(project, target, value) {
    if (target < 0 || target >= project.slides.length - 1)
      throw new Error('Выберите место между слайдами.');
    return project.slides.flatMap((slide, index) => {
      const transition = index === target ? value : transitionForGap(project, index);
      return transition
        ? [{ type: 'slide', id: slide.id }, transition]
        : [{ type: 'slide', id: slide.id }];
    });
  }
}
