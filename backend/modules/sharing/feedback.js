import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { atomicFile } from '../../storage/connectors/atomic-file.js';
import { notFound } from '../../engine/errors.js';
import { badRequest } from '../../engine/errors.js';

export function shareOptions(project) {
  return {
    comments: project.shareOptions?.comments === true,
    notes: project.shareOptions?.notes === true,
  };
}
export async function updateShareOptions(library, id, value) {
  if (
    !value ||
    Object.keys(value).some((key) => !['comments', 'notes', 'version'].includes(key)) ||
    typeof value.comments !== 'boolean' ||
    typeof value.notes !== 'boolean' ||
    !Number.isInteger(value.version)
  )
    throw badRequest('Укажите настройки ссылки и текущую версию презентации.');
  await (
    await library.getStore(id)
  ).mutate((project) => {
    if ((project.version || 0) !== value.version)
      throw Object.assign(new Error('Презентация уже изменена. Обновите настройки ссылки.'), {
        status: 409,
      });
    project.shareOptions = { comments: value.comments, notes: value.notes };
    project.version = (project.version || 0) + 1;
  });
  return shareOptions(await library.get(id));
}

// Гостевые комментарии хранятся вне presentation.json и инструментов агента.
// Обычной аннотацией комментарий становится только по явному действию владельца.
export class ShareFeedback {
  constructor(library) {
    this.library = library;
    this.queues = new Map();
    this.rates = new Map();
  }
  file(id) {
    return path.join(this.library.directory(id), 'feedback.json');
  }
  async read(id) {
    await this.library.getStore(id);
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async queue(id, action) {
    const task = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(
      id,
      task.catch(() => {}),
    );
    return task;
  }
  async list(id) {
    await this.queues.get(id);
    return this.read(id);
  }
  rate(token, address) {
    const now = Date.now();
    for (const [key, item] of this.rates) if (item.expires <= now) this.rates.delete(key);
    const key = createHash('sha256')
        .update(token + '|' + address)
        .digest('hex'),
      previous = this.rates.get(key);
    if (previous?.count >= 12 || (!previous && this.rates.size >= 10000))
      throw Object.assign(new Error('Слишком много комментариев. Попробуйте позже.'), {
        status: 429,
      });
    this.rates.set(key, {
      expires: previous?.expires || now + 3600000,
      count: (previous?.count || 0) + 1,
    });
  }
  async create(token, value, address = '') {
    const initial = await this.library.findShare(token);
    if (!shareOptions(initial).comments)
      throw Object.assign(new Error('Автор отключил комментарии по этой ссылке.'), { status: 403 });
    if (
      !value ||
      Object.keys(value).some(
        (key) => !['slideId', 'x', 'y', 'comment', 'name', 'anchorText'].includes(key),
      ) ||
      typeof value.comment !== 'string' ||
      !value.comment.trim() ||
      value.comment.length > 4000 ||
      typeof (value.name ?? '') !== 'string' ||
      (value.name || '').length > 80 ||
      typeof (value.anchorText ?? '') !== 'string' ||
      (value.anchorText || '').length > 300 ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1 ||
      !initial.slides.some((slide) => slide.id === value.slideId)
    )
      throw badRequest('Некорректный комментарий.');
    this.rate(token, address);
    return this.queue(initial.id, async () => {
      const project = await this.library.get(initial.id);
      if (project.shareToken !== token || !shareOptions(project).comments)
        throw notFound('Ссылка отозвана или комментарии отключены.');
      if (!project.slides.some((slide) => slide.id === value.slideId))
        throw badRequest('Слайд уже удалён.');
      const all = await this.read(project.id);
      if (all.length >= 1000)
        throw Object.assign(new Error('Лимит комментариев к презентации достигнут.'), {
          status: 429,
        });
      const saved = {
        id: randomUUID(),
        slideId: value.slideId,
        x: value.x,
        y: value.y,
        comment: value.comment.trim(),
        name: (value.name || '').trim(),
        anchorText: (value.anchorText || '').trim(),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      all.push(saved);
      await atomicFile(this.file(project.id), JSON.stringify(all, null, 2) + '\n');
      return saved;
    });
  }
  async approve(id, feedbackId, ai) {
    return this.queue(id, async () => {
      const all = await this.read(id),
        feedback = all.find((item) => item.id === feedbackId);
      if (!feedback) throw notFound('Комментарий не найден.');
      const store = await this.library.getStore(id),
        project = await store.read();
      if (!project.slides.some((slide) => slide.id === feedback.slideId))
        throw badRequest('Слайд удалён. Комментарий сохранён в списке отзывов.');
      // Стабильный ID позволяет повторить запись истории после ошибки без дублирования.
      let annotation = project.annotations.find((item) => item.id === feedback.id);
      if (!annotation)
        annotation = await store.saveAnnotation({
          ...feedback,
          comment: (feedback.name ? 'От ' + feedback.name + ':\n' : '') + feedback.comment,
        });
      await ai.appendAnnotation(id, annotation);
      feedback.status = 'approved';
      feedback.approvedAt ||= new Date().toISOString();
      await atomicFile(this.file(id), JSON.stringify(all, null, 2) + '\n');
      return { feedback, annotation };
    });
  }
}
