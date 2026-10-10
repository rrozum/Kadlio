import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import { imageSize } from 'image-size';
import { escapeHTML } from '../../../shared/presentation/html.js';

// Полный ограниченный импорт не зависит от сокращённого анализа образца для агента.
// Office-процессы, внешние ресурсы и код из пакета не запускаются.
export const pptxImportLimits = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  inflatedBytes: 40 * 1024 * 1024,
  parts: 2048,
  xmlBytes: 2 * 1024 * 1024,
  slides: 100,
  shapes: 5000,
  images: 256,
  imagePixels: 25_000_000,
  textCharacters: 1_000_000,
  slideHTML: 200_000,
});
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const local = (node) => node?.localName?.split(':').at(-1);
const children = (node, name) =>
  Array.from(node?.children || []).filter((item) => !name || local(item) === name);
const child = (node, name) => children(node, name)[0];
const descendants = (node, name) =>
  Array.from(node?.querySelectorAll('*') || []).filter((item) => !name || local(item) === name);
const attr = (node, name) => node?.getAttribute(name) ?? undefined;
const namespaced = (node, name) =>
  attr(node, 'r:' + name) ||
  Array.from(node?.attributes || []).find((item) => item.name.endsWith(':' + name))?.value;
const numeric = (value, fallback = 0) =>
  value !== undefined &&
  value !== null &&
  Number.isFinite(Number(value)) &&
  Math.abs(Number(value)) <= 1e10
    ? Number(value)
    : fallback;
const truth = (value) => value === '1' || value === 'true';
const round = (value) => Math.round(value * 1000) / 1000;
const styleAttribute = (value) =>
  escapeHTML(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .map(([key, item]) => key + ':' + item)
      .join(';'),
  );
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const translation = (x, y) => [1, 0, 0, 1, x, y];
const scaling = (x, y = x) => [x, 0, 0, y, 0, 0];
const identity = [1, 0, 0, 1, 0, 0];
const rotation = (angle) => {
  const radians = (angle * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
};
const mediaPath = (name) =>
  typeof name === 'string' &&
  /^ppt\/media\/[^/\\\x00-\x1f]{1,180}$/.test(name) &&
  !['.', '..'].includes(path.posix.basename(name));
const presetColors = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  blue: '#0000FF',
  green: '#008000',
  yellow: '#FFFF00',
  gray: '#808080',
  grey: '#808080',
  orange: '#FFA500',
  purple: '#800080',
  transparent: '#000000',
};
const defaultMap = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};
const importCSS =
  '.slide.pptx-imported{padding:0!important;background:#fff!important}.slide.pptx-imported .slide-content{position:static!important}.slide.pptx-imported .slide-body{position:absolute!important;inset:0;width:1280px;height:720px;padding:0;overflow:hidden}.slide.pptx-imported .section-label,.slide.pptx-imported .footer,.slide.pptx-imported .presentation-template{display:none!important}';

async function inflateEntry(entry, budget) {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('nodebuffer'),
      chunks = [];
    let size = 0,
      finished = false;
    const stop = (error) => {
      if (finished) return;
      finished = true;
      stream.pause();
      reject(error);
    };
    stream.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      budget.bytes += chunk.length;
      if (budget.bytes > pptxImportLimits.inflatedBytes)
        return stop(failure('Распакованный PPTX превышает 40 МБ.', 413));
      chunks.push(chunk);
    });
    stream
      .on('error', stop)
      .on('end', () => {
        if (!finished) {
          finished = true;
          resolve(Buffer.concat(chunks, size));
        }
      })
      .resume();
  });
}
async function archiveParts(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > pptxImportLimits.fileBytes)
    throw failure('Загрузите PPTX до 8 МБ.', 413);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw failure('Не удалось прочитать PPTX. Загрузите файл .pptx без шифрования.');
  }
  const entries = Object.values(archive.files);
  if (entries.length > pptxImportLimits.parts) throw failure('В PPTX слишком много частей.', 413);
  let declared = 0;
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      /[\x00-\x1f]/.test(name) ||
      name.split('/').includes('..')
    )
      throw failure('Небезопасный путь в PPTX.');
    if (/vbaProject|(?:^|\/)Scripts\/|(?:^|\/)Basic\/|\.(?:exe|dll)$/i.test(name))
      throw failure('PPTX с макросами или исполняемыми файлами не поддерживается.');
    declared += entry._data?.uncompressedSize || 0;
  }
  if (declared > pptxImportLimits.inflatedBytes)
    throw failure('Распакованный PPTX превышает 40 МБ.', 413);
  const parts = new Map(),
    budget = { bytes: 0 };
  for (const entry of entries) {
    if (entry.dir) continue;
    const bytes = await inflateEntry(entry, budget);
    if (/\.(?:xml|rels)$/i.test(entry.name) && bytes.length > pptxImportLimits.xmlBytes)
      throw failure('XML-часть PPTX превышает 2 МБ.', 413);
    parts.set(entry.name, bytes);
  }
  if (!parts.has('ppt/presentation.xml')) throw failure('В файле нет презентации PPTX.');
  if (/macroEnabled/i.test(parts.get('[Content_Types].xml')?.toString('utf8') || ''))
    throw failure('Презентации с макросами не поддерживаются.');
  return { parts, inflatedBytes: budget.bytes };
}

export async function importPptxDocument(buffer, { assetPrefix, includeHidden = false } = {}) {
  if (typeof assetPrefix !== 'string' || !/^\/api\/projects\/[\w-]+\/assets\/$/.test(assetPrefix))
    throw failure('Неверный каталог ресурсов импорта.');
  if (typeof includeHidden !== 'boolean') throw failure('Неверная настройка скрытых слайдов.');
  const { parts, inflatedBytes } = await archiveParts(buffer),
    xmlCache = new Map(),
    relationCache = new Map(),
    themeCache = new Map(),
    layerCache = new Map(),
    assetCache = new Map(),
    assets = [],
    warnings = new Set();
  const warn = (message) => warnings.add(message),
    state = { shapes: 0, text: 0 },
    blockPrefix = 'pptx-' + randomUUID();
  const xml = (name) => {
    if (xmlCache.has(name)) return xmlCache.get(name);
    const bytes = parts.get(name);
    if (!bytes) return null;
    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw failure('XML PPTX должен использовать UTF-8.');
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(value))
      throw failure('XML-сущности и DTD в PPTX не поддерживаются.');
    const root = new DOMParser().parseFromString(value, 'application/xml').documentElement;
    if (!root || local(root) === 'parsererror') throw failure('Повреждён XML PPTX.');
    xmlCache.set(name, root);
    return root;
  };
  // Перед записью файлов проверяем весь XML, включая неиспользуемые части пакета.
  for (const name of parts.keys()) if (/\.(?:xml|rels)$/i.test(name)) xml(name);
  const relations = (name) => {
    if (relationCache.has(name)) return relationCache.get(name);
    const root = xml(
        path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels'),
      ),
      result = Object.create(null);
    for (const item of children(root, 'Relationship')) {
      const id = attr(item, 'Id'),
        target = attr(item, 'Target'),
        type = attr(item, 'Type');
      if (!id || !target || !type) continue;
      if (attr(item, 'TargetMode') === 'External') {
        warn('Внешние ссылки и изображения не загружены.');
        continue;
      }
      if (target.includes('\\') || /[\x00-\x1f]/.test(target) || /^[a-z]+:/i.test(target)) {
        warn('Небезопасная ссылка пакета пропущена.');
        continue;
      }
      const part = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (!part.startsWith('ppt/') || part.split('/').includes('..')) {
        warn('Связь вне частей презентации пропущена.');
        continue;
      }
      result[id] = { part, type: type.split('/').at(-1) };
    }
    relationCache.set(name, result);
    return result;
  };
  const related = (name, type) =>
    Object.values(relations(name)).find((item) => item.type === type)?.part;
  const image = (name) => {
    if (assetCache.has(name)) return assetCache.get(name);
    if (!mediaPath(name)) {
      warn('Изображение вне ppt/media пропущено.');
      return null;
    }
    const bytes = parts.get(name);
    if (!bytes) {
      warn('Изображение отсутствует в PPTX.');
      return null;
    }
    let mime, extension;
    if (
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR'
    ) {
      mime = 'image/png';
      extension = 'png';
    } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      mime = 'image/jpeg';
      extension = 'jpg';
    } else if (
      bytes.length >= 16 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    ) {
      mime = 'image/webp';
      extension = 'webp';
    } else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
      mime = 'image/gif';
      extension = 'gif';
    } else {
      warn('SVG/EMF/WMF и другие нестандартные изображения не перенесены; проверьте оригинал.');
      assetCache.set(name, null);
      return null;
    }
    let dimensions;
    try {
      dimensions = imageSize(bytes);
    } catch {
      throw failure('Не удалось прочитать изображение PPTX.');
    }
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > pptxImportLimits.imagePixels
    )
      throw failure('Изображение PPTX превышает 25 мегапикселей.', 413);
    if (assets.length >= pptxImportLimits.images)
      throw failure('В PPTX слишком много изображений.', 413);
    const filename = randomUUID() + '.' + extension,
      asset = {
        name: filename,
        mime,
        buffer: bytes,
        source: name,
        width: dimensions.width,
        height: dimensions.height,
      };
    assets.push(asset);
    const result = { url: assetPrefix + filename, ...dimensions };
    assetCache.set(name, result);
    return result;
  };
  const theme = (name) => {
    if (themeCache.has(name)) return themeCache.get(name);
    const root = xml(name),
      scheme = descendants(root, 'clrScheme')[0],
      fontScheme = descendants(root, 'fontScheme')[0],
      colors = {};
    for (const item of children(scheme)) {
      const entry = child(item, 'srgbClr') || child(item, 'sysClr'),
        value = attr(entry, 'val')?.match(/^[\da-f]{6}$/i)
          ? attr(entry, 'val')
          : attr(entry, 'lastClr');
      if (value?.match(/^[\da-f]{6}$/i)) colors[local(item)] = '#' + value;
    }
    const font = (kind) =>
      attr(descendants(child(fontScheme, kind + 'Font'), 'latin')[0], 'typeface') || 'Arial';
    const value = { root, colors, major: font('major'), minor: font('minor') };
    themeCache.set(name, value);
    return value;
  };
  const color = (node, context, placeholder) => {
    const value = children(node).find((item) =>
      ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(local(item)),
    );
    if (!value) return null;
    const kind = local(value),
      name = attr(value, 'val'),
      hex =
        kind === 'srgbClr'
          ? '#' + name
          : kind === 'schemeClr'
            ? name === 'phClr'
              ? placeholder
              : context.theme.colors[context.map[name] || name]
            : kind === 'sysClr'
              ? '#' + attr(value, 'lastClr')
              : presetColors[name];
    if (!/^#[\da-f]{6}$/i.test(hex || '')) {
      warn('Неизвестный цвет заменён стандартным.');
      return '#000000';
    }
    let rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)),
      alpha = 1;
    for (const modifier of children(value)) {
      const amount = numeric(attr(modifier, 'val')) / 100000,
        type = local(modifier);
      if (type === 'alpha') alpha = amount;
      else if (type === 'alphaMod') alpha *= amount;
      else if (type === 'tint') rgb = rgb.map((channel) => channel + (255 - channel) * amount);
      else if (type === 'shade') rgb = rgb.map((channel) => channel * amount);
      else if (type === 'lumMod' || type === 'lumOff') {
        rgb = rgb.map((channel) => (type === 'lumMod' ? channel * amount : channel + 255 * amount));
        warn('Преобразование яркости цвета приблизительное.');
      } else warn('Некоторые цветовые преобразования не перенесены.');
    }
    rgb = rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
    return alpha < 1
      ? 'rgba(' + rgb.join(',') + ',' + round(Math.max(0, alpha)) + ')'
      : '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('');
  };
  const fill = (node, context, placeholder) => {
    if (child(node, 'noFill')) return { type: 'none' };
    const solid = child(node, 'solidFill');
    if (solid) return { type: 'solid', value: color(solid, context, placeholder) || 'transparent' };
    const gradient = child(node, 'gradFill');
    if (gradient) {
      const stops = children(child(gradient, 'gsLst'), 'gs').map(
        (stop) =>
          (color(stop, context, placeholder) || '#000000') +
          ' ' +
          round(numeric(attr(stop, 'pos')) / 1000) +
          '%',
      );
      if (!stops.length) return null;
      const linear = child(gradient, 'lin');
      if (!linear) warn('Радиальный градиент перенесён приблизительно.');
      return {
        type: 'gradient',
        value: linear
          ? 'linear-gradient(' +
            round(numeric(attr(linear, 'ang')) / 60000 + 90) +
            'deg,' +
            stops.join(',') +
            ')'
          : 'radial-gradient(' + stops.join(',') + ')',
      };
    }
    const picture = child(node, 'blipFill');
    if (picture) {
      const asset = image(context.rels[namespaced(child(picture, 'blip'), 'embed')]?.part);
      return asset
        ? {
            type: 'image',
            asset,
            crop: Object.fromEntries(
              ['l', 't', 'r', 'b'].map((key) => [
                key,
                numeric(attr(child(picture, 'srcRect'), key)) / 100000,
              ]),
            ),
          }
        : null;
    }
    if (child(node, 'pattFill')) warn('Узорная заливка пропущена.');
    return null;
  };
  const referenced = (node, context, kind) => {
    if (!node) return null;
    const index = numeric(attr(node, 'idx'));
    if (!index) return kind === 'line' ? { width: 0, fill: { type: 'none' } } : { type: 'none' };
    const scheme = descendants(context.theme.root, 'fmtScheme')[0],
      list = child(
        scheme,
        kind === 'line' ? 'lnStyleLst' : index >= 1001 ? 'bgFillStyleLst' : 'fillStyleLst',
      ),
      definition = children(list)[index >= 1001 ? index - 1001 : index - 1];
    if (!definition) {
      warn('Стилевая ссылка не разрешена.');
      return null;
    }
    const value = fill(
      kind === 'line' ? definition : { children: [definition] },
      context,
      color(node, context),
    );
    return kind === 'line'
      ? {
          width: numeric(attr(definition, 'w')),
          fill: value,
          dash: attr(child(definition, 'prstDash'), 'val'),
        }
      : value;
  };
  const presentation = xml('ppt/presentation.xml'),
    size = child(presentation, 'sldSz'),
    cx = numeric(attr(size, 'cx')),
    cy = numeric(attr(size, 'cy'));
  if (cx <= 0 || cy <= 0 || cx > 100_000_000 || cy > 100_000_000)
    throw failure('Не удалось определить размер PPTX.');
  const scale = Math.min(1280 / cx, 720 / cy),
    canvasWidth = round(cx * scale),
    canvasHeight = round(cy * scale),
    offsetX = (1280 - canvasWidth) / 2,
    offsetY = (720 - canvasHeight) / 2,
    rootMatrix = [scale, 0, 0, scale, offsetX, offsetY];
  if (Math.abs(cx / cy - 1280 / 720) > 0.001)
    warn('Соотношение сторон сохранено: по краям холста добавлены поля.');
  const textStyle = (node, context) => {
    if (!node) return {};
    let font = attr(child(node, 'latin'), 'typeface') || attr(child(node, 'ea'), 'typeface');
    if (font === '+mj-lt' || font === '+mj-ea') font = context.theme.major;
    if (font === '+mn-lt' || font === '+mn-ea') font = context.theme.minor;
    return {
      ...(font ? { font } : {}),
      ...(attr(node, 'sz') !== undefined
        ? { size: (((numeric(attr(node, 'sz')) / 100) * 914400) / 72) * scale }
        : {}),
      ...(attr(node, 'b') !== undefined ? { bold: truth(attr(node, 'b')) } : {}),
      ...(attr(node, 'i') !== undefined ? { italic: truth(attr(node, 'i')) } : {}),
      ...(attr(node, 'u') !== undefined ? { underline: attr(node, 'u') !== 'none' } : {}),
      ...(attr(node, 'strike') !== undefined
        ? { strike: attr(node, 'strike') !== 'noStrike' }
        : {}),
      ...(attr(node, 'spc') !== undefined
        ? { spacing: (((numeric(attr(node, 'spc')) / 100) * 914400) / 72) * scale }
        : {}),
      ...(child(node, 'solidFill') ? { color: color(child(node, 'solidFill'), context) } : {}),
    };
  };
  const textCSS = (style) => ({
    'font-family':
      JSON.stringify(String(style.font || 'Arial').slice(0, 120)) + ',Arial,sans-serif',
    'font-size': round(style.size || ((18 * 914400) / 72) * scale) + 'px',
    color: style.color || '#000000',
    'font-weight': style.bold ? '700' : '400',
    'font-style': style.italic ? 'italic' : 'normal',
    'text-decoration':
      [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
        .filter(Boolean)
        .join(' ') || 'none',
    ...(style.spacing ? { 'letter-spacing': round(style.spacing) + 'px' } : {}),
  });
  const ph = (node) => {
    const value = descendants(
      children(node).find((item) => local(item).startsWith('nv')),
      'ph',
    )[0];
    return value ? { type: attr(value, 'type') || 'body', index: attr(value, 'idx') || '0' } : null;
  };
  const inheritedShape = (placeholder, parent) => {
    if (!placeholder) return null;
    for (let current = parent; current; current = current.parent) {
      const match =
        current.shapes.find((shape) => shape.placeholder?.index === placeholder.index) ||
        current.shapes.find((shape) => shape.placeholder?.type === placeholder.type);
      if (match) return match;
    }
    return null;
  };
  const groupMatrix = (node) => {
    const xfrm = child(child(node, 'grpSpPr'), 'xfrm'),
      off = child(xfrm, 'off'),
      ext = child(xfrm, 'ext'),
      chOff = child(xfrm, 'chOff'),
      chExt = child(xfrm, 'chExt'),
      w = numeric(attr(ext, 'cx')),
      h = numeric(attr(ext, 'cy')),
      sx = w / Math.max(1, numeric(attr(chExt, 'cx'))),
      sy = h / Math.max(1, numeric(attr(chExt, 'cy')));
    let matrix = translation(numeric(attr(off, 'x')) + w / 2, numeric(attr(off, 'y')) + h / 2);
    matrix = multiply(matrix, rotation(numeric(attr(xfrm, 'rot')) / 60000));
    matrix = multiply(
      matrix,
      scaling(truth(attr(xfrm, 'flipH')) ? -1 : 1, truth(attr(xfrm, 'flipV')) ? -1 : 1),
    );
    matrix = multiply(matrix, translation(-w / 2, -h / 2));
    matrix = multiply(matrix, scaling(sx, sy));
    return multiply(matrix, translation(-numeric(attr(chOff, 'x')), -numeric(attr(chOff, 'y'))));
  };
  const layer = (name, role, parent) => {
    if (layerCache.has(name)) return layerCache.get(name);
    const root = xml(name);
    if (!root) {
      warn('Макет или мастер отсутствует в PPTX.');
      return null;
    }
    const rels = relations(name),
      themePart =
        related(name, 'theme') ||
        parent?.themePart ||
        [...parts.keys()].find((part) => /^ppt\/theme\/theme\d+\.xml$/.test(part)),
      currentTheme = theme(themePart),
      mapNode = child(root, 'clrMap') || child(child(root, 'clrMapOvr'), 'overrideClrMapping'),
      map = {
        ...(parent?.context.map || defaultMap),
        ...Object.fromEntries(
          Array.from(mapNode?.attributes || []).map((item) => [item.name, item.value]),
        ),
      },
      context = { part: name, rels, theme: currentTheme, map };
    const common = child(root, 'cSld'),
      bg = child(common, 'bg');
    let background = fill(child(bg, 'bgPr'), context) ||
      referenced(child(bg, 'bgRef'), context, 'fill') ||
      parent?.background || { type: 'solid', value: '#ffffff' };
    const defaults = {};
    for (const kind of ['title', 'body', 'other']) {
      defaults[kind] = [];
      for (let level = 1; level <= 9; level++)
        defaults[kind].push({
          ...parent?.defaults[kind]?.[level - 1],
          ...textStyle(
            child(
              child(child(child(root, 'txStyles'), kind + 'Style'), 'lvl' + level + 'pPr'),
              'defRPr',
            ),
            context,
          ),
        });
    }
    const result = {
      name,
      role,
      root,
      parent,
      themePart,
      context,
      background,
      defaults,
      shapes: [],
      showMasterShapes:
        attr(root, 'showMasterSp') === undefined || truth(attr(root, 'showMasterSp')),
    };
    layerCache.set(name, result);
    const visit = (tree, matrix = identity, depth = 0) => {
      if (depth > 16) throw failure('Группы фигур PPTX вложены слишком глубоко.', 413);
      for (const node of children(tree)) {
        const kind = local(node);
        if (kind === 'grpSp') {
          visit(node, multiply(matrix, groupMatrix(node)), depth + 1);
          continue;
        }
        if (!['sp', 'pic', 'cxnSp', 'graphicFrame'].includes(kind)) continue;
        if (++state.shapes > pptxImportLimits.shapes)
          throw failure('В PPTX больше 5000 фигур.', 413);
        const placeholder = ph(node),
          inherited = inheritedShape(placeholder, parent),
          properties = child(node, 'spPr'),
          xfrm = child(properties, 'xfrm') || child(node, 'xfrm') || inherited?.xfrm,
          off = child(xfrm, 'off'),
          ext = child(xfrm, 'ext');
        if (!off || !ext) {
          warn('Фигура без координат пропущена.');
          continue;
        }
        const width = numeric(attr(ext, 'cx')),
          height = numeric(attr(ext, 'cy'));
        if (width < 0 || height < 0 || width > 200_000_000 || height > 200_000_000)
          throw failure('Некорректный размер фигуры PPTX.');
        let transform = multiply(
          matrix,
          translation(numeric(attr(off, 'x')), numeric(attr(off, 'y'))),
        );
        transform = multiply(transform, translation(width / 2, height / 2));
        transform = multiply(transform, rotation(numeric(attr(xfrm, 'rot')) / 60000));
        transform = multiply(
          transform,
          scaling(truth(attr(xfrm, 'flipH')) ? -1 : 1, truth(attr(xfrm, 'flipV')) ? -1 : 1),
        );
        transform = multiply(transform, translation(-width / 2, -height / 2));
        const nonVisual = children(node).find((item) => local(item).startsWith('nv')),
          nv = child(nonVisual, 'cNvPr'),
          style = child(node, 'style'),
          lineNode = child(properties, 'ln'),
          lineFill = fill(lineNode, context),
          hasLine =
            lineNode &&
            (lineFill ||
              attr(lineNode, 'w') !== undefined ||
              child(lineNode, 'headEnd') ||
              child(lineNode, 'tailEnd')),
          line = hasLine
            ? {
                width: numeric(attr(lineNode, 'w'), 9525),
                fill: lineFill,
                dash: attr(child(lineNode, 'prstDash'), 'val'),
                head: attr(child(lineNode, 'headEnd'), 'type'),
                tail: attr(child(lineNode, 'tailEnd'), 'type'),
              }
            : referenced(child(style, 'lnRef'), context, 'line') || inherited?.line;
        const shapeFill = (kind === 'pic' ? fill(node, context) : fill(properties, context)) ||
          referenced(child(style, 'fillRef'), context, 'fill') ||
          inherited?.fill || { type: 'none' };
        const value = {
          node,
          kind,
          placeholder,
          inherited,
          xfrm,
          width,
          height,
          transform,
          fill: shapeFill,
          line,
          name: (attr(nv, 'name') || 'Фигура').slice(0, 160),
          id: attr(nv, 'id') || String(state.shapes),
          geometry: (attr(child(properties, 'prstGeom'), 'prst') || 'rect').slice(0, 80),
          context,
          layer: result,
        };
        if (
          descendants(properties, 'effectLst').some((item) => item.children.length) ||
          descendants(properties, 'scene3d').length ||
          descendants(properties, 'sp3d').length
        )
          warn('Тени, трёхмерные и некоторые декоративные эффекты не перенесены.');
        if (
          descendants(node, 'videoFile').length ||
          descendants(node, 'audioFile').length ||
          descendants(node, 'oleObj').length
        )
          warn('Видео, аудио и встроенные объекты PPTX не импортированы.');
        result.shapes.push(value);
      }
    };
    visit(child(common, 'spTree'));
    return result;
  };
  const paragraphDefaults = (shape, level) => {
    const kind = ['title', 'ctrTitle'].includes(shape.placeholder?.type)
      ? 'title'
      : shape.placeholder?.type === 'body'
        ? 'body'
        : 'other';
    let style = { ...shape.layer.defaults[kind][level] };
    const chain = [];
    for (let item = shape.inherited; item; item = item.inherited) chain.unshift(item);
    chain.push(shape);
    for (const item of chain) {
      const body = child(item.node, 'txBody'),
        list = child(body, 'lstStyle'),
        levelNode = child(list, 'lvl' + (level + 1) + 'pPr'),
        firstParagraph = child(body, 'p');
      style = {
        ...style,
        ...textStyle(child(levelNode, 'defRPr'), item.context),
        ...textStyle(child(child(firstParagraph, 'pPr'), 'defRPr'), item.context),
      };
    }
    return style;
  };
  const plainText = (node) =>
    children(node, 'p')
      .map((paragraph) =>
        children(paragraph)
          .map((run) => (local(run) === 'br' ? '\n' : child(run, 't')?.textContent || ''))
          .join(''),
      )
      .join('\n');
  const renderText = (shape, id) => {
    const body = child(shape.node, 'txBody');
    if (!body) return '';
    const paragraphs = children(body, 'p'),
      bodyPr = child(body, 'bodyPr'),
      fontRef = child(child(shape.node, 'style'), 'fontRef'),
      firstRun = children(paragraphs[0]).find((run) => ['r', 'fld'].includes(local(run))),
      base = {
        ...paragraphDefaults(shape, 0),
        ...textStyle(child(child(paragraphs[0], 'pPr'), 'defRPr'), shape.context),
        ...textStyle(child(firstRun, 'rPr'), shape.context),
      };
    if (!base.font)
      base.font =
        attr(fontRef, 'idx') === 'major' ? shape.context.theme.major : shape.context.theme.minor;
    const content = [];
    for (const paragraph of paragraphs) {
      const pPr = child(paragraph, 'pPr'),
        level = Math.max(0, Math.min(8, numeric(attr(pPr, 'lvl')))),
        defaultStyle = {
          ...base,
          ...paragraphDefaults(shape, level),
          ...textStyle(child(pPr, 'defRPr'), shape.context),
        },
        runs = [];
      for (const run of children(paragraph)) {
        if (local(run) === 'br') {
          runs.push('<br>');
          continue;
        }
        if (!['r', 'fld'].includes(local(run))) continue;
        let text = child(run, 't')?.textContent || '';
        state.text += text.length;
        if (state.text > pptxImportLimits.textCharacters)
          throw failure('В PPTX слишком много текста.', 413);
        if (local(run) === 'fld' && attr(run, 'type') === 'slidenum')
          text = String(shape.slideNumber || 1);
        const style = { ...defaultStyle, ...textStyle(child(run, 'rPr'), shape.context) };
        runs.push(
          '<span style="' + styleAttribute(textCSS(style)) + '">' + escapeHTML(text) + '</span>',
        );
      }
      const align =
          { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[
            attr(pPr, 'algn')
          ] || 'left',
        line = child(pPr, 'lnSpc'),
        percent = child(line, 'spcPct'),
        points = child(line, 'spcPts'),
        spacing = (kind) => {
          const node = child(pPr, kind),
            pt = child(node, 'spcPts'),
            pct = child(node, 'spcPct');
          return pt
            ? round((((numeric(attr(pt, 'val')) / 100) * 914400) / 72) * scale) + 'px'
            : pct
              ? numeric(attr(pct, 'val')) / 100000 + 'em'
              : '0';
        };
      const bullet = child(pPr, 'buChar'),
        auto = child(pPr, 'buAutoNum'),
        hasBullet = !child(pPr, 'buNone') && (bullet || auto),
        prefix = hasBullet
          ? '<span aria-hidden="true">' +
            escapeHTML(attr(bullet, 'char') || (auto ? String(content.length + 1) + '.' : '•')) +
            ' </span>'
          : '';
      const paragraphCSS = {
        margin: '0',
        'text-align': align,
        'line-height': points
          ? round((((numeric(attr(points, 'val')) / 100) * 914400) / 72) * scale) + 'px'
          : percent
            ? numeric(attr(percent, 'val')) / 100000
            : '1.1',
        'margin-top': spacing('spcBef'),
        'margin-bottom': spacing('spcAft'),
        ...(attr(pPr, 'marL') !== undefined
          ? { 'padding-left': round(numeric(attr(pPr, 'marL')) * scale) + 'px' }
          : hasBullet
            ? { 'padding-left': round(level * 16) + 'px' }
            : {}),
      };
      content.push(
        '<div style="' +
          styleAttribute(paragraphCSS) +
          '">' +
          prefix +
          (runs.join('') || '<br>') +
          '</div>',
      );
    }
    if (!plainText(body)) return '';
    const inset = {
        left: numeric(attr(bodyPr, 'lIns'), 91440) * scale,
        right: numeric(attr(bodyPr, 'rIns'), 91440) * scale,
        top: numeric(attr(bodyPr, 'tIns'), 45720) * scale,
        bottom: numeric(attr(bodyPr, 'bIns'), 45720) * scale,
      },
      vertical = attr(bodyPr, 'anchor') || 't',
      vert = attr(bodyPr, 'vert');
    if (vert && vert !== 'horz') warn('Вертикальный текст перенесён приблизительно.');
    if (child(bodyPr, 'normAutofit') || child(bodyPr, 'spAutoFit'))
      warn('Автоподбор размера текста может отличаться от PowerPoint.');
    const css = {
      position: 'absolute',
      left: round(inset.left) + 'px',
      top: round(inset.top) + 'px',
      width: round(Math.max(0, shape.width * scale - inset.left - inset.right)) + 'px',
      height: round(Math.max(0, shape.height * scale - inset.top - inset.bottom)) + 'px',
      margin: 0,
      padding: 0,
      'box-sizing': 'border-box',
      display: 'flex',
      'flex-direction': 'column',
      'justify-content':
        vertical === 'ctr' ? 'center' : vertical === 'b' ? 'flex-end' : 'flex-start',
      overflow: 'visible',
      'overflow-wrap': 'break-word',
      'white-space': 'pre-wrap',
      ...textCSS(base),
      ...(vert && vert !== 'horz' ? { 'writing-mode': 'vertical-rl' } : {}),
    };
    return (
      '<div data-block-id="' +
      id +
      '-text" data-block-type="text" style="' +
      styleAttribute(css) +
      '">' +
      content.join('') +
      '</div>'
    );
  };
  const pathData = (node, w, h) => {
    const custom = child(child(node, 'spPr'), 'custGeom');
    if (!custom) return null;
    const paths = [];
    for (const definition of children(child(custom, 'pathLst'), 'path')) {
      const pw = numeric(attr(definition, 'w'), w / scale),
        ph = numeric(attr(definition, 'h'), h / scale),
        commands = [];
      let valid = pw > 0 && ph > 0;
      for (const command of children(definition)) {
        const type = local(command),
          points = children(command, 'pt').map((point) => {
            const x = attr(point, 'x'),
              y = attr(point, 'y');
            if (!/^-?\d+$/.test(x || '') || !/^-?\d+$/.test(y || '')) valid = false;
            return round((numeric(x) * w) / pw) + ' ' + round((numeric(y) * h) / ph);
          });
        const letter = { moveTo: 'M', lnTo: 'L', cubicBezTo: 'C', quadBezTo: 'Q', close: 'Z' }[
          type
        ];
        if (!letter) valid = false;
        else commands.push(letter + points.join(' '));
      }
      if (!valid) {
        warn('Сложный контур с формулами заменён простой фигурой.');
        return null;
      }
      paths.push(commands.join(' '));
    }
    return paths.length ? paths : null;
  };
  const renderVector = (shape, id) => {
    const width = Math.max(1, shape.width * scale),
      height = Math.max(1, shape.height * scale),
      line = shape.line,
      stroke =
        line?.fill?.type === 'solid'
          ? line.fill.value
          : line?.fill?.type === 'none'
            ? 'none'
            : line
              ? '#000000'
              : 'none',
      strokeWidth = Math.max(0, (line?.width || 0) * scale),
      fillValue =
        shape.fill?.type === 'solid'
          ? shape.fill.value
          : shape.fill?.type === 'none'
            ? 'none'
            : shape.fill?.type === 'gradient'
              ? 'url(#' + id + '-gradient)'
              : 'none';
    let definitions = '';
    if (shape.fill?.type === 'gradient') {
      // CSS-градиенты сохраняем на обёртке; векторная фигура обрезает её прямоугольник.
      warn('Градиент внутри непрямоугольной фигуры перенесён приблизительно.');
    }
    const paint =
      ' fill="' +
      escapeHTML(fillValue === 'url(#' + id + '-gradient)' ? 'none' : fillValue) +
      '" stroke="' +
      escapeHTML(stroke) +
      '" stroke-width="' +
      round(strokeWidth) +
      '"' +
      (line?.dash && line.dash !== 'solid'
        ? ' stroke-dasharray="' + round(strokeWidth * 4) + ' ' + round(strokeWidth * 3) + '"'
        : '');
    const geometry = shape.geometry;
    let svg = '';
    const custom = pathData(shape.node, width, height);
    if (custom) svg = custom.map((value) => '<path d="' + value + '"' + paint + '/>').join('');
    else if (shape.kind === 'cxnSp' || geometry === 'line' || geometry === 'straightConnector1') {
      const marker = (side, type) => {
        if (!type || type === 'none') return '';
        definitions +=
          '<marker id="' +
          id +
          '-' +
          side +
          '" viewBox="0 0 10 10" refX="' +
          (side === 'head' ? 1 : 9) +
          '" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="' +
          escapeHTML(stroke) +
          '"/></marker>';
        return (
          ' marker-' + (side === 'head' ? 'start' : 'end') + '="url(#' + id + '-' + side + ')"'
        );
      };
      svg =
        '<line x1="0" y1="0" x2="' +
        round(width) +
        '" y2="' +
        round(height) +
        '"' +
        paint +
        marker('head', line?.head) +
        marker('tail', line?.tail) +
        '/>';
    } else if (geometry === 'ellipse')
      svg =
        '<ellipse cx="' +
        round(width / 2) +
        '" cy="' +
        round(height / 2) +
        '" rx="' +
        round(Math.max(0, width / 2 - strokeWidth / 2)) +
        '" ry="' +
        round(Math.max(0, height / 2 - strokeWidth / 2)) +
        '"' +
        paint +
        '/>';
    else if (['rect', 'roundRect', 'round1Rect', 'round2SameRect'].includes(geometry))
      svg =
        '<rect x="' +
        round(strokeWidth / 2) +
        '" y="' +
        round(strokeWidth / 2) +
        '" width="' +
        round(Math.max(0, width - strokeWidth)) +
        '" height="' +
        round(Math.max(0, height - strokeWidth)) +
        '" rx="' +
        (geometry === 'rect' ? 0 : round(Math.min(width, height) * 0.16)) +
        '"' +
        paint +
        '/>';
    else {
      const points = {
        triangle: [
          [0.5, 0],
          [1, 1],
          [0, 1],
        ],
        rtTriangle: [
          [0, 0],
          [1, 1],
          [0, 1],
        ],
        diamond: [
          [0.5, 0],
          [1, 0.5],
          [0.5, 1],
          [0, 0.5],
        ],
        parallelogram: [
          [0.2, 0],
          [1, 0],
          [0.8, 1],
          [0, 1],
        ],
        trapezoid: [
          [0.2, 0],
          [0.8, 0],
          [1, 1],
          [0, 1],
        ],
        chevron: [
          [0, 0],
          [0.7, 0],
          [1, 0.5],
          [0.7, 1],
          [0, 1],
          [0.3, 0.5],
        ],
        rightArrow: [
          [0, 0.25],
          [0.6, 0.25],
          [0.6, 0],
          [1, 0.5],
          [0.6, 1],
          [0.6, 0.75],
          [0, 0.75],
        ],
        leftArrow: [
          [1, 0.25],
          [0.4, 0.25],
          [0.4, 0],
          [0, 0.5],
          [0.4, 1],
          [0.4, 0.75],
          [1, 0.75],
        ],
        hexagon: [
          [0.25, 0],
          [0.75, 0],
          [1, 0.5],
          [0.75, 1],
          [0.25, 1],
          [0, 0.5],
        ],
        pentagon: [
          [0.5, 0],
          [1, 0.4],
          [0.8, 1],
          [0.2, 1],
          [0, 0.4],
        ],
      }[geometry];
      if (points)
        svg =
          '<polygon points="' +
          points.map(([x, y]) => round(x * width) + ',' + round(y * height)).join(' ') +
          '"' +
          paint +
          '/>';
      else {
        warn('Некоторые фигуры заменены прямоугольниками: ' + geometry + '.');
        svg = '<rect width="' + round(width) + '" height="' + round(height) + '"' + paint + '/>';
      }
    }
    return (
      '<svg viewBox="0 0 ' +
      round(width) +
      ' ' +
      round(height) +
      '" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" style="position:absolute;inset:0;overflow:visible;pointer-events:none">' +
      (definitions ? '<defs>' + definitions + '</defs>' : '') +
      svg +
      '</svg>'
    );
  };
  const renderShape = (shape, index, slideNumber) => {
    shape.slideNumber = slideNumber;
    const id = blockPrefix + '-' + slideNumber + '-' + shape.layer.role + '-' + index,
      global = multiply(rootMatrix, shape.transform),
      width = Math.max(1, shape.width * scale),
      height = Math.max(1, shape.height * scale),
      css = {
        position: 'absolute',
        left: round(global[4]) + 'px',
        top: round(global[5]) + 'px',
        width: round(width) + 'px',
        height: round(height) + 'px',
        margin: 0,
        padding: 0,
        'box-sizing': 'border-box',
        'transform-origin': '0 0',
        transform:
          'matrix(' +
          [global[0] / scale, global[1] / scale, global[2] / scale, global[3] / scale, 0, 0]
            .map(round)
            .join(',') +
          ')',
      };
    const label = escapeHTML(shape.name),
      text = renderText(shape, id),
      layerAttributes =
        ' data-pptx-layer="' +
        shape.layer.role +
        '"' +
        (shape.layer.role !== 'slide' ? ' data-locked="true"' : '');
    if (shape.kind === 'graphicFrame') {
      warn('Таблицы, диаграммы и SmartArt заменены обозначениями: сверяйте их с оригиналом.');
      return (
        '<div data-block-id="' +
        id +
        '" data-block-type="text"' +
        layerAttributes +
        ' data-pptx-unsupported="graphicFrame" style="' +
        styleAttribute({
          ...css,
          border: '1px dashed #888',
          color: '#666',
          background: '#ffffffcc',
          font: '16px/1.3 Arial',
          overflow: 'hidden',
        }) +
        '">' +
        escapeHTML('Не перенесено: ' + shape.name) +
        '</div>'
      );
    }
    if (shape.fill?.type === 'image') {
      const picture = shape.fill,
        asset = picture.asset,
        crop = picture.crop || {},
        visibleX = 1 - (crop.l || 0) - (crop.r || 0),
        visibleY = 1 - (crop.t || 0) - (crop.b || 0);
      if (visibleX <= 0 || visibleY <= 0) {
        warn('Некорректная обрезка изображения пропущена.');
        return '';
      }
      if (!text && Object.values(crop).every((value) => !value))
        return (
          '<img data-block-id="' +
          id +
          '" data-block-type="image"' +
          layerAttributes +
          ' src="' +
          escapeHTML(asset.url) +
          '" alt="' +
          label +
          '" style="' +
          styleAttribute({ ...css, 'object-fit': 'fill' }) +
          '">'
        );
      const imageCSS = {
        position: 'absolute',
        left: round((-(crop.l || 0) / visibleX) * width) + 'px',
        top: round((-(crop.t || 0) / visibleY) * height) + 'px',
        width: round(width / visibleX) + 'px',
        height: round(height / visibleY) + 'px',
        'object-fit': 'fill',
        margin: 0,
      };
      return (
        '<div data-block-id="' +
        id +
        '" data-block-type="element"' +
        layerAttributes +
        ' style="' +
        styleAttribute({ ...css, overflow: 'hidden' }) +
        '"><img data-block-id="' +
        id +
        '-image" data-block-type="image" src="' +
        escapeHTML(asset.url) +
        '" alt="' +
        label +
        '" style="' +
        styleAttribute(imageCSS) +
        '">' +
        text +
        '</div>'
      );
    }
    const hasShape =
      shape.fill?.type !== 'none' ||
      (shape.line && shape.line.fill?.type !== 'none') ||
      shape.kind === 'cxnSp';
    const simple =
      ['rect', 'roundRect', 'round1Rect', 'round2SameRect', 'ellipse'].includes(shape.geometry) &&
      !child(child(shape.node, 'spPr'), 'custGeom') &&
      shape.kind !== 'cxnSp';
    if (simple) {
      if (shape.fill?.type === 'solid' || shape.fill?.type === 'gradient')
        css.background = shape.fill.value;
      if (shape.line?.fill?.type !== 'none' && shape.line) {
        css.border =
          round((shape.line.width || 0) * scale) +
          'px ' +
          (shape.line.dash && shape.line.dash !== 'solid' ? 'dashed' : 'solid') +
          ' ' +
          (shape.line.fill?.value || '#000000');
      }
      if (shape.geometry === 'ellipse') css['border-radius'] = '50%';
      else if (shape.geometry !== 'rect')
        css['border-radius'] = round(Math.min(width, height) * 0.16) + 'px';
    } else if (shape.fill?.type === 'gradient') css.background = shape.fill.value;
    return (
      '<div data-block-id="' +
      id +
      '" data-block-type="' +
      (hasShape ? 'shape' : 'text') +
      '"' +
      layerAttributes +
      ' data-pptx-shape="' +
      escapeHTML(shape.geometry) +
      '" aria-label="' +
      label +
      '" style="' +
      styleAttribute(css) +
      '">' +
      (hasShape && !simple ? renderVector(shape, id) : '') +
      text +
      '</div>'
    );
  };
  const slideIds = children(child(presentation, 'sldIdLst'), 'sldId');
  if (!slideIds.length) throw failure('В PPTX нет слайдов.');
  if (slideIds.length > pptxImportLimits.slides)
    throw failure('Импорт поддерживает до 100 слайдов.', 413);
  const slides = [];
  let hiddenCount = 0;
  for (const [sourceIndex, item] of slideIds.entries()) {
    const part = relations('ppt/presentation.xml')[namespaced(item, 'id')]?.part;
    if (!part) throw failure('В PPTX отсутствует часть слайда.');
    const root = xml(part);
    if (!root) throw failure('В PPTX отсутствует XML слайда.');
    const hidden = attr(root, 'show') === '0' || attr(root, 'show') === 'false';
    if (hidden) {
      hiddenCount++;
      if (!includeHidden) continue;
    }
    const layoutName = related(part, 'slideLayout'),
      masterName = layoutName ? related(layoutName, 'slideMaster') : null,
      master = masterName ? layer(masterName, 'master') : null,
      layout = layoutName ? layer(layoutName, 'layout', master) : null,
      current = layer(part, 'slide', layout || master),
      number = slides.length + 1,
      background = current.background,
      fillCSS =
        background.type === 'image'
          ? 'url("' + background.asset.url + '")'
          : background.value || 'transparent';
    const body = [
      '<style>' +
        importCSS +
        '</style><div data-block-id="' +
        blockPrefix +
        '-' +
        number +
        '-background" data-block-type="shape" data-pptx-layer="background" data-locked="true" data-pptx-background="true" style="' +
        styleAttribute({
          position: 'absolute',
          left: round(offsetX) + 'px',
          top: round(offsetY) + 'px',
          width: canvasWidth + 'px',
          height: canvasHeight + 'px',
          background: fillCSS,
          'background-size': '100% 100%',
          'pointer-events': 'none',
        }) +
        '"></div>',
    ];
    const layers = [
      ...(current.showMasterShapes && layout?.showMasterShapes && master ? [master] : []),
      ...(layout ? [layout] : []),
      current,
    ];
    for (const entry of layers)
      for (const [index, shape] of entry.shapes.entries()) {
        if (entry !== current && shape.placeholder) {
          const kind = shape.placeholder.type;
          if (!['ftr', 'dt', 'sldNum', 'hdr'].includes(kind)) continue;
          const flag =
            kind === 'sldNum' ? 'sldNum' : kind === 'ftr' ? 'ftr' : kind === 'dt' ? 'dt' : 'hdr';
          const hf = child(root, 'hf') || child(layout?.root, 'hf') || child(master?.root, 'hf');
          if (!truth(attr(hf, flag))) continue;
        }
        body.push(renderShape(shape, index, number));
      }
    const notesPart = related(part, 'notesSlide'),
      notesRoot = notesPart ? xml(notesPart) : null,
      notes = descendants(notesRoot, 'sp')
        .filter((node) => ph(node)?.type === 'body')
        .map((node) => plainText(child(node, 'txBody')))
        .filter(Boolean)
        .join('\n\n');
    const titleShape =
        current.shapes.find((shape) => ['title', 'ctrTitle'].includes(shape.placeholder?.type)) ||
        current.shapes.find((shape) => plainText(child(shape.node, 'txBody'))),
      title = (titleShape ? plainText(child(titleShape.node, 'txBody')) : 'Слайд ' + number)
        .split('\n')[0]
        .slice(0, 200);
    if (child(root, 'transition') || child(root, 'timing'))
      warn('Переходы и анимации PPTX не импортированы.');
    const html = body.join('');
    if (html.length > pptxImportLimits.slideHTML)
      throw failure('HTML одного слайда превышает 200 000 символов.', 413);
    if (notes.length > 100000)
      throw failure('Заметки одного слайда превышают 100 000 символов.', 413);
    slides.push({
      title,
      body: html,
      notes,
      sourceText: layers
        .flatMap((entry) => entry.shapes.map((shape) => plainText(child(shape.node, 'txBody'))))
        .filter(Boolean)
        .join('\n'),
      sourceSlide: sourceIndex + 1,
      hidden,
    });
  }
  if (!slides.length) throw failure('Нет видимых слайдов. Включите импорт скрытых слайдов.');
  if (hiddenCount)
    warn(
      includeHidden
        ? 'Скрытые слайды включены в импорт как обычные.'
        : 'Скрытые слайды пропущены: ' + hiddenCount + '.',
    );
  if ([...parts.keys()].some((name) => /^ppt\/fonts\//.test(name)))
    warn('Встроенные шрифты не импортированы. Используются доступные шрифты браузера.');
  const core = xml('docProps/core.xml'),
    documentTitle = descendants(core, 'title')[0]?.textContent || '',
    author = descendants(core, 'creator')[0]?.textContent || '';
  const firstTheme = [...themeCache.values()][0];
  return {
    slides,
    assets,
    css: importCSS,
    title: documentTitle.slice(0, 200),
    author: author.slice(0, 200),
    font: firstTheme?.minor || 'Arial',
    importReport: {
      format: 'pptx',
      sourceSlideCount: slideIds.length,
      importedSlideCount: slides.length,
      hiddenSlideCount: hiddenCount,
      includeHidden,
      canvas: {
        width: 1280,
        height: 720,
        sourceWidth: cx,
        sourceHeight: cy,
        scale: Number(scale.toPrecision(8)),
        offsetX: round(offsetX),
        offsetY: round(offsetY),
      },
      editable: true,
      warnings: [
        ...warnings,
        'Шрифты, переносы текста и сложные эффекты могут отличаться от PowerPoint.',
      ],
      limits: { ...pptxImportLimits, inflatedBytesRead: inflatedBytes },
    },
  };
}

const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
function checkedName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 200 ||
    /[\\/\x00-\x1f\x7f]/.test(name) ||
    !name.toLowerCase().endsWith('.pptx')
  )
    throw failure('Загрузите файл с именем .pptx без пути.');
  return name.trim();
}
function decodeUpload(data) {
  if (
    typeof data !== 'string' ||
    !data.length ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
    data.length > Math.ceil(pptxImportLimits.fileBytes / 3) * 4
  )
    throw failure('Загрузите PPTX до 8 МБ в корректном base64.', 413);
  const buffer = Buffer.from(data, 'base64');
  if (buffer.toString('base64') !== data) throw failure('Некорректный base64 PPTX.');
  return buffer;
}
const importedSlide = (slide, number) => ({
  id: 'slide-' + String(number).padStart(2, '0'),
  title: slide.title || 'Слайд ' + number,
  seconds: 60,
  section: '',
  layout: 'pptx-imported',
  kind: 'main',
  notes: slide.notes,
  notesVersion: 0,
  version: 0,
  importedFrom: { slide: slide.sourceSlide, hidden: slide.hidden },
});
function importedDesign(document) {
  return {
    schemaVersion: 1,
    themeId: 'pptx-import',
    tokens: {
      background: '#ffffff',
      text: '#111111',
      muted: '#666666',
      accent: '#199af0',
      surface: '#eeeeee',
      border: '#cccccc',
      font: /^[-\w\s,"']+$/.test(document.font) ? document.font : 'Arial',
    },
    background: { type: 'solid', value: '#ffffff' },
    decorations: [],
    metadata: { author: document.author, brand: '' },
    template: {
      header: '',
      footer: '',
      showAuthor: false,
      showProjectTitle: false,
      showSlideNumber: false,
      html: '',
    },
  };
}
async function stagingDirectory(library) {
  const directory = path.join(library.dataDir, 'import-staging', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
async function writeDocumentFiles(directory, document, slides) {
  for (const sub of ['slides', 'assets'])
    await mkdir(path.join(directory, sub), { recursive: true, mode: 0o700 });
  for (const [index, slide] of slides.entries())
    await writeFile(
      path.join(directory, 'slides', slide.id + '.html'),
      document.slides[index].body,
      { mode: 0o600, flag: 'wx' },
    );
  for (const asset of document.assets)
    await writeFile(path.join(directory, 'assets', asset.name), asset.buffer, {
      mode: 0o600,
      flag: 'wx',
    });
}
async function writeOriginal(directory, buffer, name, document) {
  const id = randomUUID(),
    material = {
      id,
      name,
      mime: pptxMime,
      size: buffer.length,
      kind: 'document',
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    location = path.join(directory, 'materials');
  await mkdir(location, { recursive: true, mode: 0o700 });
  const text = document.slides.map((slide) => slide.sourceText + '\n' + slide.notes).join('\n\n'),
    extracted = { text: text.slice(0, 100000), status: 'ready', truncated: text.length > 100000 };
  for (const [suffix, content] of [
    ['.bin', buffer],
    ['.json', JSON.stringify(material) + '\n'],
    ['.extracted.json', JSON.stringify(extracted) + '\n'],
  ])
    await writeFile(path.join(location, id + suffix), content, { mode: 0o600, flag: 'wx' });
  return material;
}

// Новый проект становится виден только после записи слайдов, ресурсов и
// приватного оригинала. Удаление неудачной временной сборки не затрагивает презентации.
export async function createPptxProject(library, payload = {}) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some(
      (key) => !['name', 'mime', 'data', 'title', 'includeHidden'].includes(key),
    )
  )
    throw failure('Неверные поля импорта PPTX.');
  const name = checkedName(payload.name),
    buffer = decodeUpload(payload.data);
  if (
    payload.title !== undefined &&
    (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 200)
  )
    throw failure('Название должно содержать до 200 символов.');
  const id = randomUUID(),
    document = await importPptxDocument(buffer, {
      assetPrefix: '/api/projects/' + id + '/assets/',
      includeHidden: payload.includeHidden,
    }),
    directory = await stagingDirectory(library),
    timestamp = new Date().toISOString();
  try {
    const slides = document.slides.map((slide, index) => importedSlide(slide, index + 1));
    await writeDocumentFiles(directory, document, slides);
    const material = await writeOriginal(directory, buffer, name, document);
    const project = {
      schemaVersion: 1,
      id,
      title: payload.title?.trim() || document.title || name.replace(/\.pptx$/i, ''),
      description: '',
      creationMode: 'manual',
      creation: { status: 'ready', attempts: 0, updatedAt: timestamp },
      author: document.author,
      brand: '',
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      design: importedDesign(document),
      slides,
      timeline: slides.map((slide) => ({ type: 'slide', id: slide.id })),
      annotations: [],
      importReport: { ...document.importReport, materialId: material.id, importedAt: timestamp },
    };
    await writeFile(path.join(directory, 'theme.css'), document.css, { mode: 0o600, flag: 'wx' });
    await writeFile(
      path.join(directory, 'presentation.json'),
      JSON.stringify(project, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await rename(directory, library.directory(id));
    return library.get(id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// В существующий проект сначала пишем новые уникальные файлы, затем выполняем
// одну CAS-запись метаданных. Старые HTML и ресурсы сохраняются. Явная замена
// архивирует метаданные слайдов, timeline и аннотаций, не перезаписывая старые HTML.
export async function importPptxIntoProject(
  library,
  id,
  { buffer, name, version, mode = 'append', includeHidden = false } = {},
) {
  checkedName(name);
  if (!Number.isInteger(version) || !['append', 'replace'].includes(mode))
    throw failure('Нужны версия проекта и режим append или replace.');
  const store = await library.getStore(id),
    document = await importPptxDocument(buffer, {
      assetPrefix: '/api/projects/' + id + '/assets/',
      includeHidden,
    }),
    stage = await stagingDirectory(library),
    written = [];
  let committed = false;
  try {
    await store.mutate((project) =>
      library.materials.queue(id, async () => {
        if (project.version !== version)
          throw failure('Презентация уже изменена. Прочитайте её перед импортом.', 409);
        if ((mode === 'append' ? project.slides.length : 0) + document.slides.length > 100)
          throw failure('В одной презентации максимум 100 слайдов.');
        const materials = await library.materials.list(id);
        if (
          materials.length >= 50 ||
          materials.reduce((sum, item) => sum + item.size, 0) + buffer.length > 100 * 1024 * 1024
        )
          throw failure('В проекте недостаточно места для оригинала PPTX.', 413);
        const number = Math.max(0, ...project.slides.map((slide) => Number(slide.id.slice(6)))) + 1,
          slides = document.slides.map((slide, index) => importedSlide(slide, number + index));
        await writeDocumentFiles(stage, document, slides);
        const material = await writeOriginal(stage, buffer, name, document),
          target = library.directory(id);
        if (mode === 'replace') {
          const archive = path.join(target, 'imports', material.id);
          await mkdir(archive, { recursive: true, mode: 0o700 });
          const backup = path.join(archive, 'before.json');
          await writeFile(backup, JSON.stringify(project, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
          written.push(backup);
        }
        for (const sub of ['slides', 'assets', 'materials']) {
          await mkdir(path.join(target, sub), { recursive: true, mode: 0o700 });
          for (const filename of await readdir(path.join(stage, sub))) {
            const destination = path.join(target, sub, filename);
            await writeFile(destination, await readFile(path.join(stage, sub, filename)), {
              mode: 0o600,
              flag: 'wx',
            });
            written.push(destination);
          }
        }
        if (mode === 'replace') {
          project.slides = slides;
          project.timeline = slides.map((slide) => ({ type: 'slide', id: slide.id }));
          project.annotations = [];
        } else {
          project.slides.push(...slides);
          project.timeline = [
            ...(project.timeline ||
              project.slides
                .slice(0, -slides.length)
                .map((slide) => ({ type: 'slide', id: slide.id }))),
            ...slides.map((slide) => ({ type: 'slide', id: slide.id })),
          ];
        }
        project.version++;
        project.importReport = {
          ...document.importReport,
          mode,
          materialId: material.id,
          importedAt: new Date().toISOString(),
          ...(mode === 'replace'
            ? { previousMetadata: 'imports/' + material.id + '/before.json' }
            : {}),
        };
      }),
    );
    committed = true;
    return await library.get(id);
  } catch (error) {
    if (!committed) for (const file of written) await rm(file, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
