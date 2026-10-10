import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { badRequest } from '../../engine/errors.js';
import { validAssetURL, assetReferences, validateThemeCSS } from '../../engine/html/design.js';
import {
  designElements,
  renderDesignElement,
} from '../../../shared/addons/design-elements/catalog.js';

const safeId = /^[\w-]{1,100}$/;
const missing = () => Object.assign(new Error('Элемент не найден.'), { status: 404 });
const builtin = (id) => designElements.find((item) => item.id === id);
async function atomic(file, content) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
const metadata = ({ body, ...record }) => record;

function checkedBody(body, ownerId, scope) {
  if (typeof body !== 'string' || !body.trim() || body.length > 100000)
    throw badRequest('Укажите HTML элемента до 100 000 символов.');
  const { document } = parseHTML('<html><body>' + body + '</body></html>');
  if (
    document.body.children.length !== 1 ||
    [...document.body.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
  )
    throw badRequest('Элемент должен содержать один корневой HTML-блок.');
  if (
    document.body.querySelector(
      'script,style,iframe,object,embed,base,meta,link,form,input,textarea,select,foreignObject,animate,set',
    )
  )
    throw badRequest('Используйте HTML/SVG и встроенные стили без исполняемого кода.');
  const ids = new Set(),
    fragments = [];
  for (const node of document.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const key = attr.name.toLowerCase(),
        value = attr.value.trim();
      if (
        key.startsWith('on') ||
        ['srcdoc', 'srcset', 'formaction', 'action', 'data-template-layer'].includes(key)
      )
        throw badRequest('Недопустимый атрибут элемента.');
      if (
        ['src', 'href', 'xlink:href'].includes(key) &&
        !validAssetURL(value, ownerId, scope) &&
        !/^#[\w-]+$/.test(value) &&
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)
      )
        throw badRequest('Изображения должны принадлежать текущей презентации или теме.');
      if (key === 'style')
        validateThemeCSS(
          'a{' +
            value.replace(/url\(\s*(["']?)#([\w-]+)\1\s*\)/gi, (_, quote, id) => {
              fragments.push(id);
              return 'none';
            }) +
            '}',
          ownerId,
          scope,
        );
      if (['href', 'xlink:href'].includes(key) && value.startsWith('#'))
        fragments.push(value.slice(1));
      if (key === 'id') {
        if (!safeId.test(value) || ids.has(value))
          throw badRequest('SVG/HTML идентификаторы должны быть уникальны.');
        ids.add(value);
      }
      if (/url\(/i.test(value) && key !== 'style')
        for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
          if (!/^#[\w-]+$/.test(match[2]))
            throw badRequest('SVG может ссылаться только на свои элементы.');
          fragments.push(match[2].slice(1));
        }
    }
    node.removeAttribute('data-block-id');
    node.removeAttribute('data-element-id');
  }
  if (fragments.some((id) => !ids.has(id)))
    throw badRequest('SVG/HTML ссылки должны указывать на ID внутри элемента.');
  return document.body.innerHTML;
}

// Шаблоны — обычный HTML. Изображения копируем сначала в каталог, затем
// при вставке в презентацию: удаление исходной презентации не ломает шаблон.
export class ElementStore {
  constructor(library) {
    this.library = library;
    this.root = path.join(library.dataDir, 'elements');
  }
  directory(id) {
    if (typeof id !== 'string' || !safeId.test(id)) throw missing();
    return path.join(this.root, id);
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return this;
  }
  async get(id) {
    const preset = builtin(id);
    if (preset)
      return {
        ...preset,
        builtin: true,
        body: renderDesignElement(id, { blockId: 'preview-' + id }),
      };
    try {
      return JSON.parse(await readFile(path.join(this.directory(id), 'element.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw missing();
      throw error;
    }
  }
  async list() {
    const items = designElements.map((item) => ({ ...item, builtin: true }));
    for (const id of await readdir(this.root))
      if (safeId.test(id))
        try {
          items.push(metadata(await this.get(id)));
        } catch (error) {
          if (error.status !== 404) throw error;
        }
    return items;
  }
  async create(ownerId, payload, { scope = 'projects' } = {}) {
    if (!['projects', 'themes'].includes(scope)) throw badRequest('Неверный контекст элемента.');
    await (scope === 'themes' ? this.library.themes.get(ownerId) : this.library.get(ownerId));
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).some(
        (key) => !['name', 'description', 'width', 'height', 'body'].includes(key),
      )
    )
      throw badRequest('Некорректные поля элемента.');
    const { name, description = '', width, height, body } = payload;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      typeof description !== 'string' ||
      description.length > 500 ||
      !Number.isInteger(width) ||
      width < 8 ||
      width > 1280 ||
      !Number.isInteger(height) ||
      height < 8 ||
      height > 720
    )
      throw badRequest('Укажите название и размер элемента в пределах слайда 1280×720.');
    const source = checkedBody(body, ownerId, scope),
      references = assetReferences(source);
    if (references.length > 16)
      throw badRequest('Элемент может содержать не более 16 изображений.');
    const id = randomUUID(),
      directory = this.directory(id),
      from = '/api/' + scope + '/' + ownerId + '/assets/',
      to = '/api/elements/' + id + '/assets/';
    try {
      await mkdir(path.join(directory, 'assets'), { recursive: true, mode: 0o700 });
      let bytes = 0;
      for (const url of references) {
        const image = await (scope === 'themes'
          ? this.library.themes.asset(ownerId, path.basename(url))
          : this.library.asset(ownerId, path.basename(url)));
        bytes += image.length;
        if (bytes > 32 * 1024 * 1024) throw badRequest('Изображения элемента слишком большие.');
        await atomic(path.join(directory, 'assets', path.basename(url)), image);
      }
      const { document } = parseHTML(
          '<html><body>' + source.replaceAll(from, to) + '</body></html>',
        ),
        root = document.body.firstElementChild;
      root.style.position = 'absolute';
      root.style.left = '0px';
      root.style.top = '0px';
      root.style.width = width + 'px';
      root.style.height = height + 'px';
      root.style.boxSizing = 'border-box';
      const record = {
        id,
        name: name.trim(),
        description,
        category: 'custom',
        width,
        height,
        builtin: false,
        fields: [],
        defaults: {},
        createdAt: new Date().toISOString(),
        body: root.outerHTML,
      };
      await atomic(path.join(directory, 'element.json'), JSON.stringify(record, null, 2) + '\n');
      return metadata(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async asset(id, name) {
    if (
      builtin(id) ||
      typeof name !== 'string' ||
      !/^[\w.-]{1,120}$/.test(name) ||
      name.includes('..')
    )
      throw missing();
    await this.get(id);
    try {
      return await readFile(path.join(this.directory(id), 'assets', name));
    } catch (error) {
      if (error.code === 'ENOENT') throw missing();
      throw error;
    }
  }
  async materialize(
    id,
    { ownerId, scope = 'projects', values = {}, blockId = 'element-' + randomUUID() } = {},
  ) {
    if (!safeId.test(blockId) || !values || typeof values !== 'object' || Array.isArray(values))
      throw badRequest('Некорректные параметры элемента.');
    const record = await this.get(id),
      { x = 96, y = 180, ...fields } = values;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw badRequest('Некорректная позиция элемента.');
    let body;
    if (record.builtin)
      try {
        body = renderDesignElement(id, { values: fields, blockId });
      } catch (error) {
        throw badRequest(error.message);
      }
    else {
      if (Object.keys(fields).length)
        throw badRequest(
          'Пользовательский элемент изменяется на холсте через HTML и свойства блоков.',
        );
      body = record.body;
      const references = [
        ...new Set(body.match(/\/api\/elements\/[\w-]+\/assets\/[\w.-]+/g) || []),
      ];
      for (const url of references) {
        const name = path.basename(url),
          buffer = await this.asset(id, name),
          mime = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
          }[path.extname(name).toLowerCase()];
        if (!mime) throw badRequest('Неверный формат изображения элемента.');
        const upload = { name, mime, data: buffer.toString('base64') };
        const saved = await (scope === 'themes'
          ? this.library.themes.uploadAsset(ownerId, upload)
          : this.library.uploadAsset(ownerId, upload));
        body = body.replaceAll(url, saved.url);
      }
    }
    const { document } = parseHTML('<html><body>' + body + '</body></html>'),
      root = document.body.firstElementChild;
    const remap = new Map();
    let count = 0;
    for (const node of document.body.querySelectorAll('[id]')) {
      const old = node.id,
        next = blockId + '-svg-' + ++count;
      remap.set(old, next);
      node.id = next;
    }
    for (const node of document.body.querySelectorAll('*')) {
      for (const attr of [...node.attributes]) {
        let value = attr.value.replace(
          /url\(\s*(["']?)#([\w-]+)\1\s*\)/gi,
          (original, quote, id) =>
            remap.has(id) ? 'url(' + quote + '#' + remap.get(id) + quote + ')' : original,
        );
        if (
          ['href', 'xlink:href'].includes(attr.name) &&
          value.startsWith('#') &&
          remap.has(value.slice(1))
        )
          value = '#' + remap.get(value.slice(1));
        if (['for', 'aria-labelledby', 'aria-describedby', 'aria-controls'].includes(attr.name))
          value = value
            .split(/\s+/)
            .map((id) => remap.get(id) || id)
            .join(' ');
        if (value !== attr.value) node.setAttribute(attr.name, value);
      }
      if (node !== root && node.hasAttribute('data-block-id'))
        node.setAttribute('data-block-id', blockId + '-child-' + ++count);
    }
    root.setAttribute('data-block-id', blockId);
    root.setAttribute('data-block-type', 'element');
    root.setAttribute('data-element-id', id);
    root.setAttribute('aria-label', record.name);
    root.style.left = Math.round(Math.max(0, Math.min(1280 - record.width, x))) + 'px';
    root.style.top = Math.round(Math.max(0, Math.min(720 - record.height, y))) + 'px';
    return root.outerHTML;
  }
}
