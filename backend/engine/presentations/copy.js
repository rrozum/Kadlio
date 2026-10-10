import path from 'node:path';
import { mkdir, cp, rm, rename, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { badRequest } from '../errors.js';
import { atomicFile } from '../../storage/connectors/atomic-file.js';

// Копирование сериализовано с правками оригинала. Собираем копию приватно, затем
// делаем её доступной. Копируются только файлы презентации, без аккаунта и состояния агента.
export async function copyProject(library, id, { version } = {}) {
  if (!Number.isInteger(version)) throw badRequest('Необходима версия исходной презентации.');
  const store = await library.getStore(id);
  const operation = store.queue
    .catch(() => {})
    .then(async () => {
      const source = await store.snapshot();
      if ((source.version || 0) !== version)
        throw Object.assign(
          new Error('Презентация уже изменилась. Обновите список и повторите копирование.'),
          { status: 409 },
        );
      const newId = randomUUID(),
        directory = library.directory(newId),
        staging = path.join(library.projectsDir, '.copy-' + newId),
        now = new Date().toISOString();
      const rebase = (value) =>
        value.replaceAll('/api/projects/' + id + '/', '/api/projects/' + newId + '/');
      try {
        await mkdir(path.join(staging, 'slides'), { recursive: true, mode: 0o700 });
        for (const slide of source.slides)
          await atomicFile(path.join(staging, 'slides', slide.id + '.html'), rebase(slide.body));
        await atomicFile(
          path.join(staging, 'theme.css'),
          rebase(await readFile(path.join(library.directory(id), 'theme.css'), 'utf8')),
        );
        await library.materials.queue(id, async () => {
          for (const folder of ['assets', 'materials'])
            try {
              await cp(path.join(library.directory(id), folder), path.join(staging, folder), {
                recursive: true,
                errorOnExist: true,
                force: false,
              });
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
        });
        // URL материалов тоже привязываем к новому проекту; кэш извлечения — обычные данные.
        for (const file of await readdir(path.join(staging, 'materials')).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        }))
          if (/^[\w-]+\.json$/.test(file)) {
            const target = path.join(staging, 'materials', file);
            await atomicFile(target, rebase(await readFile(target, 'utf8')));
          }
        const copy = {
          ...source,
          id: newId,
          title: source.title.slice(0, 192) + ' — копия',
          version: 0,
          createdAt: now,
          updatedAt: now,
          shareToken: null,
          creationMode: 'manual',
          creation: { status: 'ready', attempts: 0, updatedAt: now },
          slides: source.slides.map(({ body, ...slide }) => ({
            ...slide,
            version: 0,
            notesVersion: 0,
          })),
          annotations: source.annotations.map((annotation) => ({
            ...annotation,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
          })),
        };
        if (copy.design) copy.design = JSON.parse(rebase(JSON.stringify(copy.design)));
        // Программы и снимки их параметров тоже могут ссылаться на ресурсы проекта.
        // Меняем только метаданные презентации, не исходные байты материалов.
        for (const slide of copy.slides) {
          if (typeof slide.script === 'string') slide.script = rebase(slide.script);
          if (slide.elementEffects)
            slide.elementEffects = JSON.parse(rebase(JSON.stringify(slide.elementEffects)));
        }
        if (copy.timeline) copy.timeline = JSON.parse(rebase(JSON.stringify(copy.timeline)));
        await atomicFile(
          path.join(staging, 'presentation.json'),
          JSON.stringify(copy, null, 2) + '\n',
        );
        await rename(staging, directory);
        return newId;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
  store.queue = operation.catch(() => {});
  const newId = await operation;
  return library.get(newId);
}
