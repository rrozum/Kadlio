import { randomUUID } from 'node:crypto';
import { PresentationRepository } from '../../storage/repositories/presentation.js';
import { badRequest } from '../errors.js';

export class ProjectStore {
  constructor(root, file) {
    this.repository = new PresentationRepository(root, file);
    this.root = root;
    this.file = this.repository.file;
  }
  get queue() {
    return this.repository.queue;
  }
  set queue(value) {
    this.repository.queue = value;
  }
  get onChange() {
    return this.repository.onChange;
  }
  set onChange(value) {
    this.repository.onChange = value;
  }
  read() {
    return this.repository.read();
  }
  mutate(callback) {
    return this.repository.mutate(callback);
  }
  snapshot() {
    return this.repository.snapshot();
  }
  async saveNotes(changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 100)
      throw badRequest('Необходим список заметок');
    return this.mutate((project) => {
      const checked = changes.map((change) => {
        const slide = project.slides.find((s) => s.id === change.id);
        if (
          !slide ||
          typeof change.notes !== 'string' ||
          change.notes.length > 100000 ||
          !Number.isInteger(change.version)
        )
          throw badRequest('Некорректная заметка');
        if (slide.notes !== change.notes && (slide.notesVersion || 0) !== change.version) {
          const error = new Error(
            'Заметку уже изменили в другом окне. Скопируйте свой текст, обновите страницу и согласуйте правки.',
          );
          error.status = 409;
          throw error;
        }
        return { slide, change };
      });
      return checked.map(({ slide, change }) => {
        if (slide.notes !== change.notes) {
          slide.notes = change.notes;
          slide.notesVersion = (slide.notesVersion || 0) + 1;
        }
        return { id: slide.id, notes: slide.notes, version: slide.notesVersion || 0 };
      });
    });
  }
  async saveAnnotation(value) {
    return this.mutate((project) => {
      if (
        !value ||
        typeof value.id !== 'string' ||
        value.id.length > 100 ||
        !project.slides.some((s) => s.id === value.slideId) ||
        typeof value.comment !== 'string' ||
        !value.comment.trim() ||
        value.comment.length > 10000 ||
        !Number.isFinite(value.x) ||
        !Number.isFinite(value.y) ||
        value.x < 0 ||
        value.x > 1 ||
        value.y < 0 ||
        value.y > 1
      )
        throw badRequest('Некорректный комментарий');
      const previous = project.annotations.find((a) => a.id === value.id);
      const saved = {
        id: value.id,
        slideId: value.slideId,
        x: value.x,
        y: value.y,
        comment: value.comment.trim(),
        anchorText: String(value.anchorText || '').slice(0, 300),
        resolved: value.resolved === true,
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (previous) Object.assign(previous, saved);
      else project.annotations.push(saved);
      return saved;
    });
  }
  async deleteAnnotation(id) {
    return this.mutate((p) => {
      p.annotations = p.annotations.filter((a) => a.id !== id);
      return { ok: true };
    });
  }
  async importAnnotations(values) {
    if (!Array.isArray(values) || values.length > 1000)
      throw badRequest('Неверный список комментариев');
    // Все записи проверяются до единственной атомарной записи.
    return this.mutate((p) => {
      const all = values.map((a) => {
        if (
          !a ||
          !p.slides.some((s) => s.id === a.slideId) ||
          typeof a.comment !== 'string' ||
          !a.comment.trim() ||
          a.comment.length > 10000 ||
          !Number.isFinite(a.x) ||
          !Number.isFinite(a.y) ||
          a.x < 0 ||
          a.x > 1 ||
          a.y < 0 ||
          a.y > 1
        )
          throw badRequest('Неверная аннотация в JSON');
        return {
          id: typeof a.id === 'string' && a.id.length <= 100 ? a.id : randomUUID(),
          slideId: a.slideId,
          x: a.x,
          y: a.y,
          comment: a.comment.trim(),
          anchorText: String(a.anchorText || '').slice(0, 300),
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });
      for (const a of all) {
        const old = p.annotations.find((x) => x.id === a.id);
        if (old) Object.assign(old, a);
        else p.annotations.push(a);
      }
      return p.annotations;
    });
  }
}
