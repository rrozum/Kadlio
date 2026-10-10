import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { blockPresets, themePresets } from '../../../shared/addons/compositions/catalog.js';
import { documentVisualHint } from '../previews/documents.js';
import { inspectPresentationReference, readReferenceImage } from '../imports/reference.js';
import { searchPresentationIcons } from '../../../shared/addons/icons/catalog.js';
import { insertPresentationIcon } from '../addons/icons.js';

import { toolDefinitions, themeToolDefinitions } from './definitions.js';
export { toolDefinitions, themeToolDefinitions } from './definitions.js';

// Адаптер ограничивает контекст и проверяет аргументы протокола. Собственного
// хранилища здесь нет: HTTP-редактор, API-модель и ACP/MCP используют тот же
// движок, поэтому правила HTML, CAS и доступа не расходятся между интерфейсами.
export function createProjectTools(
  library,
  {
    boundProjectId,
    attachments,
    skillsDir = fileURLToPath(new URL('../../../skills', import.meta.url)),
  } = {},
) {
  function projectId(args, context) {
    const bound = boundProjectId || context?.projectId;
    if (bound && args.projectId && bound !== args.projectId)
      throw new Error('Инструмент ограничен текущей презентацией.');
    const id = bound || args.projectId;
    if (!id) throw new Error('Укажите projectId.');
    return id;
  }
  return {
    definitions: toolDefinitions,
    async execute(name, args = {}, context = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Ожидались аргументы инструмента.');
      const definition = toolDefinitions.find((tool) => tool.name === name);
      if (!definition) throw new Error('Неизвестный инструмент.');
      validateArguments(definition.inputSchema, args);
      context.signal?.throwIfAborted();
      if (name === 'list_presets') return { blocks: blockPresets, themes: themePresets };
      if (name === 'search_icons')
        return {
          icons: searchPresentationIcons(args.query || '', {
            limit: args.limit,
            offset: args.offset,
          }),
        };
      if (name === 'list_elements') return { elements: await library.elements.list() };
      if (name === 'list_effect_snippets') return { snippets: await library.snippets.list() };
      if (name === 'read_effect_snippet') return library.snippets.get(args.snippetId);
      if (name === 'create_effect_snippet') return library.snippets.create(args);
      if (name === 'update_effect_snippet') {
        const { snippetId, ...payload } = args;
        return library.snippets.update(snippetId, payload);
      }
      if (name === 'list_themes') return { themes: await library.themes.list() };
      if (name === 'read_theme') return library.themes.get(args.themeId);
      if (name === 'render_theme')
        return library.renderer.renderTheme(args.themeId, { signal: context.signal });
      if (name === 'create_theme') {
        if (args.projectId) projectId(args, context);
        return library.themes.create(args);
      }
      if (name === 'update_theme') {
        const { themeId, ...changes } = args;
        return library.themes.update(themeId, changes);
      }
      if (name === 'list_skills') {
        const entries = await readdir(skillsDir, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
          .map((entry) => ({ name: entry.name }));
      }
      if (name === 'read_skill') {
        if (typeof args.name !== 'string' || !/^[a-z0-9-]{1,80}$/.test(args.name))
          throw new Error('Неверное имя skill.');
        const content = await readFile(path.join(skillsDir, args.name, 'SKILL.md'), 'utf8');
        if (content.length > 100_000) throw new Error('Skill слишком большой.');
        return { name: args.name, content };
      }
      if (name === 'list_projects') {
        return boundProjectId || context.projectId
          ? [await library.get(boundProjectId || context.projectId)].map(
              ({ id, title, version }) => ({ id, title, version }),
            )
          : library.list();
      }
      const id = projectId(args, context);
      switch (name) {
        case 'create_design_element': {
          const { projectId: ignored, ...payload } = args;
          return library.elements.create(id, payload);
        }
        case 'render_design_element':
          return library.renderer.renderElement(args.elementId, { signal: context.signal });
        case 'read_project': {
          const { shareToken, ...current } = await library.get(id);
          return current;
        }
        case 'read_slide': {
          const current = await library.get(id);
          const selected = current.slides.find((item) => item.id === args.slideId);
          if (!selected) throw new Error('Слайд не найден.');
          return selected;
        }
        case 'render_slide':
          return library.renderer.render(id, args.slideId, {
            signal: context.signal,
            atMs: args.atMs,
          });
        case 'apply_effect_snippet': {
          const { projectId: ignored, slideId, ...payload } = args;
          return library.applyElementEffect(id, slideId, payload);
        }
        case 'read_attachment': {
          return readAttachment(attachments || library.attachments, id, args.attachmentId, context);
        }
        case 'render_document_page':
          return library.documentPreviews.render(
            await readSource(library, attachments || library.attachments, id, args),
            args.page,
            { signal: context.signal },
          );
        case 'inspect_presentation_reference': {
          const source = await readSource(library, attachments || library.attachments, id, args);
          return inspectReference(source, args);
        }
        case 'use_reference_image': {
          const source = await readSource(library, attachments || library.attachments, id, args),
            image = await readReferenceImage(source.buffer, args.assetId);
          return library.uploadAsset(id, {
            name: image.name,
            mime: image.mime,
            data: image.buffer.toString('base64'),
          });
        }
        case 'use_attachment_image': {
          const { metadata, buffer } = await (attachments || library.attachments).read(
            id,
            args.attachmentId,
          );
          if (metadata.kind !== 'image')
            throw Object.assign(
              new Error('Это вложение не является изображением PNG, JPEG, WebP или GIF.'),
              { status: 400 },
            );
          return library.uploadAsset(id, {
            name: metadata.name,
            mime: metadata.mime,
            data: buffer.toString('base64'),
          });
        }
        case 'use_attachment_video': {
          const { metadata, buffer } = await (attachments || library.attachments).read(
            id,
            args.attachmentId,
          );
          const mime = /\.mp4$/i.test(metadata.name)
            ? 'video/mp4'
            : /\.webm$/i.test(metadata.name)
              ? 'video/webm'
              : null;
          if (!mime) throw new Error('Загрузите MP4 или WebM.');
          return library.uploadAsset(id, {
            name: metadata.name,
            mime,
            data: buffer.toString('base64'),
          });
        }
        case 'import_pptx': {
          const source = await readSource(library, attachments || library.attachments, id, args);
          if (!/\.pptx$/i.test(source.metadata.name)) throw new Error('Импорт поддерживает PPTX.');
          return library.importPptxInto(id, {
            buffer: source.buffer,
            name: source.metadata.name,
            version: args.version,
            mode: args.mode,
            includeHidden: args.includeHidden,
          });
        }
        case 'list_materials':
          return {
            materials: (await library.materials.list(id)).map((item) => ({
              ...item,
              ...(documentVisualHint(item) ? { document: documentVisualHint(item) } : {}),
            })),
          };
        case 'read_material': {
          const result = await library.materials.readMaterial(id, args.materialId);
          if (documentVisualHint(result.material))
            return {
              ...result,
              ...(await library.documentPreviews.render(
                await library.materials.read(id, args.materialId),
                1,
                { signal: context.signal },
              )),
            };
          return result;
        }
        case 'use_material_image': {
          const { metadata, buffer } = await library.materials.read(id, args.materialId);
          if (metadata.kind !== 'image' || metadata.status !== 'ready')
            throw Object.assign(
              new Error('Материал не является доступным изображением PNG, JPEG, WebP или GIF.'),
              { status: 400 },
            );
          return library.uploadAsset(id, {
            name: metadata.name,
            mime: metadata.mime,
            data: buffer.toString('base64'),
          });
        }
        case 'update_slide': {
          const { slideId, projectId: ignored, ...changes } = args;
          return library.updateSlide(id, slideId, changes);
        }
        case 'add_slide':
          return library.addSlide(id, { body: args.body, title: args.title });
        case 'duplicate_slide':
          return library.duplicateSlide(id, args.slideId, { version: args.version });
        case 'update_timeline':
          return library.updateTimeline(id, { timeline: args.timeline, version: args.version });
        case 'insert_preset':
          return library.insertPreset(id, args.slideId, {
            presetId: args.presetId,
            values: args.values,
            version: args.version,
          });
        case 'insert_icon':
          return insertPresentationIcon(library, id, args.slideId, {
            iconId: args.iconId,
            values: args.values,
            version: args.version,
          });
        case 'insert_element':
          return library.insertElement(id, args.slideId, {
            elementId: args.elementId,
            values: args.values,
            version: args.version,
          });
        case 'apply_theme':
          return library.applyTheme(id, { themeId: args.themeId, version: args.version });
        case 'update_design':
          return library.updateDesign(id, { design: args.design, version: args.version });
        case 'update_variables': {
          const { projectId: ignored, ...payload } = args;
          return library.updateVariables(id, payload);
        }
        case 'update_project_css':
          return library.updateCSS(id, { css: args.css, version: args.version });
        case 'reorder_slides':
          return library.reorder(id, args.ids);
        case 'update_notes': {
          const store = await library.getStore(id);
          return store.saveNotes([
            { id: args.slideId, notes: args.notes, version: args.notesVersion },
          ]);
        }
        case 'read_annotations':
          return (await library.get(id)).annotations;
        case 'resolve_annotation': {
          const current = await library.get(id);
          const annotation = current.annotations.find((item) => item.id === args.annotationId);
          if (!annotation) throw new Error('Аннотация не найдена.');
          return (await library.getStore(id)).saveAnnotation({ ...annotation, resolved: true });
        }
      }
    },
  };
}

export function createThemeTools(library, { boundThemeId, attachments, skillsDir } = {}) {
  const catalogs = createProjectTools(library, { skillsDir });
  return {
    scope: 'theme',
    definitions: themeToolDefinitions,
    async execute(name, args = {}, context = {}) {
      const definition = themeToolDefinitions.find((tool) => tool.name === name);
      if (!definition) throw new Error('Инструмент недоступен в редакторе темы.');
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Ожидались аргументы инструмента.');
      validateArguments(definition.inputSchema, args);
      context.signal?.throwIfAborted();
      const id = boundThemeId || context.themeId;
      if (!id) throw new Error('Укажите текущую тему.');
      if (args.themeId && args.themeId !== id)
        throw new Error('Инструмент ограничен текущей темой.');
      await library.themes.get(id);
      if (
        ['list_presets', 'list_elements', 'search_icons', 'list_skills', 'read_skill'].includes(
          name,
        )
      )
        return catalogs.execute(name, args, context);
      if (name === 'create_design_element') {
        const { themeId: ignored, ...payload } = args;
        return library.elements.create(id, payload, { scope: 'themes' });
      }
      if (name === 'render_design_element')
        return library.renderer.renderElement(args.elementId, { signal: context.signal });
      if (name === 'read_theme') return library.themes.get(id);
      if (name === 'render_theme')
        return library.renderer.renderTheme(id, { signal: context.signal });
      if (name === 'update_theme') {
        const { themeId: ignored, ...changes } = args;
        return library.themes.update(id, changes);
      }
      const store = attachments || library.themeAttachments;
      if (name === 'read_attachment') {
        return readAttachment(store, id, args.attachmentId, context);
      }
      if (name === 'render_document_page')
        return library.documentPreviews.render(await store.read(id, args.attachmentId), args.page, {
          signal: context.signal,
        });
      if (name === 'inspect_presentation_reference')
        return inspectReference(await store.read(id, args.attachmentId), args);
      if (name === 'use_reference_image') {
        const image = await readReferenceImage(
          (await store.read(id, args.attachmentId)).buffer,
          args.assetId,
        );
        return library.themes.uploadAsset(id, {
          name: image.name,
          mime: image.mime,
          data: image.buffer.toString('base64'),
        });
      }
      const { metadata, buffer } = await store.read(id, args.attachmentId);
      if (name === 'use_attachment_video') {
        const mime = /\.mp4$/i.test(metadata.name)
          ? 'video/mp4'
          : /\.webm$/i.test(metadata.name)
            ? 'video/webm'
            : null;
        if (!mime) throw new Error('Загрузите MP4 или WebM.');
        return library.themes.uploadAsset(id, {
          name: metadata.name,
          mime,
          data: buffer.toString('base64'),
        });
      }
      if (metadata.kind !== 'image')
        throw Object.assign(
          new Error('Это вложение не является изображением PNG, JPEG, WebP или GIF.'),
          { status: 400 },
        );
      return library.themes.uploadAsset(id, {
        name: metadata.name,
        mime: metadata.mime,
        data: buffer.toString('base64'),
      });
    },
  };
}

async function readSource(library, attachments, id, args) {
  if (Boolean(args.attachmentId) === Boolean(args.materialId))
    throw new Error('Укажите ровно один attachmentId или materialId.');
  return args.attachmentId
    ? attachments.read(id, args.attachmentId)
    : library.materials.read(id, args.materialId);
}
async function readAttachment(store, id, attachmentId, context) {
  const current = await store.context(id, [attachmentId], { signal: context.signal }),
    image = current.images[0],
    text = current.texts[0],
    document = current.documents?.[0];
  const { id: ignored, ...visual } = document || {};
  return {
    attachment: current.attachments[0],
    ...(text ? { text: text.text, status: text.status, truncated: text.truncated } : {}),
    ...visual,
    ...(image ? { preview: { mimeType: image.mime, data: image.data } } : {}),
  };
}
async function inspectReference(source, args) {
  if (path.extname(source.metadata.name).toLowerCase() !== '.pptx')
    throw new Error(
      'Структурное чтение дизайна поддерживает PPTX. Для PDF/ODP используйте render_document_page.',
    );
  return {
    source: { id: source.metadata.id, name: source.metadata.name },
    reference: await inspectPresentationReference(source.buffer, {
      maxSlides: args.maxSlides,
      maxShapes: args.maxShapes,
    }),
  };
}

function validateArguments(schema, args) {
  for (const key of schema.required)
    if (args[key] === undefined) throw new Error(`Укажите ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error(`Неизвестный аргумент: ${key}.`);
    if (rule.type === 'object' || Array.isArray(rule.type)) {
      if (value === null && Array.isArray(rule.type) && rule.type.includes('null')) continue;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(value).length > 700_000
      )
        throw new Error(`Неверный аргумент: ${key}.`);
    }
    if (
      (rule.type === 'integer' && !Number.isInteger(value)) ||
      (rule.type === 'number' && (!Number.isFinite(value) || typeof value !== 'number')) ||
      (rule.type === 'string' && (typeof value !== 'string' || value.length > 2_000_000)) ||
      (rule.type === 'array' &&
        (!Array.isArray(value) ||
          value.length > (rule.maxItems ?? 1000) ||
          value.some((item) =>
            rule.items.type === 'string'
              ? typeof item !== 'string'
              : !item || typeof item !== 'object' || Array.isArray(item),
          )))
    )
      throw new Error(`Неверный аргумент: ${key}.`);
    if (
      (rule.type === 'boolean' && typeof value !== 'boolean') ||
      (rule.enum && !rule.enum.includes(value))
    )
      throw new Error(`Неверный аргумент: ${key}.`);
    if (rule.minimum !== undefined && value < rule.minimum)
      throw new Error(`Неверный аргумент: ${key}.`);
    if (rule.maximum !== undefined && value > rule.maximum)
      throw new Error(`Неверный аргумент: ${key}.`);
  }
}
