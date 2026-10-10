import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJSON, writeJSONAtomic } from '../connectors/json-files.js';

export class PresentationRepository {
  constructor(root, file = path.join(root, 'presentation.json')) {
    this.root = root;
    this.file = file;
    this.queue = Promise.resolve();
  }
  async read() {
    const project = await readJSON(this.file);
    if (
      project.schemaVersion !== 1 ||
      !Array.isArray(project.slides) ||
      !Array.isArray(project.annotations)
    )
      throw new Error('Неверный формат presentation.json');
    return project;
  }
  mutate(callback) {
    // Очередь охватывает чтение, CAS в callback и запись. Проверять версию
    // до входа в очередь нельзя: соседний запрос может успеть сохранить правку.
    const action = this.queue
      .catch(() => {})
      .then(async () => {
        const project = await this.read();
        const result = await callback(project);
        project.updatedAt = new Date().toISOString();
        await writeJSONAtomic(this.file, project, {});
        this.onChange?.(project);
        return result;
      });
    this.queue = action;
    return action;
  }
  async snapshot() {
    const project = await this.read();
    const slides = await Promise.all(
      project.slides.map(async (slide) => {
        if (!/^slide-\d+$/.test(slide.id)) throw new Error('Некорректный id слайда');
        return {
          ...slide,
          body: await readFile(path.join(this.root, 'slides', slide.id + '.html'), 'utf8'),
        };
      }),
    );
    return { ...project, slides };
  }
}
