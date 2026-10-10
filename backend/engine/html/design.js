import { badRequest } from '../errors.js';
import { parseHTML } from 'linkedom';
import { scopeThemeCSS, templateVariables } from '../../../shared/presentation/design.js';

const color = /^#[a-f\d]{6}$/i;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max;

export function validatePresentationDesign(value, ownerId, { assetScope = 'projects' } = {}) {
  if (value === null) return null;
  const invalid = () => {
    throw badRequest('Некорректная тема или шаблон презентации.');
  };
  if (
    !keys(value, [
      'schemaVersion',
      'themeId',
      'tokens',
      'background',
      'decorations',
      'metadata',
      'template',
      'sourceCSS',
    ]) ||
    value.schemaVersion !== 1 ||
    !text(value.themeId, 64) ||
    !/^[\w-]+$/.test(value.themeId)
  )
    invalid();
  const t = value.tokens;
  if (
    !keys(t, ['background', 'text', 'muted', 'accent', 'surface', 'border', 'font']) ||
    !['background', 'text', 'muted', 'accent', 'surface', 'border'].every((key) =>
      color.test(t[key]),
    ) ||
    !text(t.font, 120) ||
    !/^[-\w\s,"']+$/.test(t.font)
  )
    invalid();
  const b = value.background;
  if (!keys(b, ['type', 'value', 'poster']) || !text(b.value, 300)) invalid();
  if (b.type === 'solid') {
    if (!color.test(b.value)) invalid();
  } else if (b.type === 'gradient') {
    if (
      !/^(linear|radial)-gradient\([#\w.,%()\s-]+\)$/i.test(b.value) ||
      /url|var|expression/i.test(b.value)
    )
      invalid();
  } else if (b.type === 'image') {
    if (!validAssetURL(b.value, ownerId, assetScope)) invalid();
  } else if (b.type === 'video') {
    if (
      !validAssetURL(b.value, ownerId, assetScope) ||
      !/\.(mp4|webm)$/i.test(b.value) ||
      (b.poster !== undefined &&
        (!validAssetURL(b.poster, ownerId, assetScope) ||
          !/\.(png|jpe?g|webp|gif)$/i.test(b.poster)))
    )
      invalid();
  } else invalid();
  if (b.type !== 'video' && b.poster !== undefined) invalid();
  if (!Array.isArray(value.decorations) || value.decorations.length > 32) invalid();
  const ids = new Set();
  for (const d of value.decorations) {
    if (
      !keys(d, ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'opacity', 'rotation']) ||
      !text(d.id, 60) ||
      !/^[\w-]+$/.test(d.id) ||
      ids.has(d.id) ||
      !['circle', 'line'].includes(d.type) ||
      !number(d.x, -1280, 1280) ||
      !number(d.y, -720, 720) ||
      !number(d.width, 1, 2560) ||
      !number(d.height, 1, 1440) ||
      !color.test(d.color) ||
      !number(d.opacity, 0, 1) ||
      (d.rotation !== undefined && !number(d.rotation, -360, 360))
    )
      invalid();
    ids.add(d.id);
  }
  const m = value.metadata;
  if (!keys(m, ['author', 'brand']) || !text(m.author, 200) || !text(m.brand, 200)) invalid();
  const p = value.template;
  if (
    !keys(p, [
      'header',
      'footer',
      'showAuthor',
      'showProjectTitle',
      'showSlideNumber',
      'html',
      'css',
    ]) ||
    !text(p.header, 500) ||
    !text(p.footer, 500) ||
    !['showAuthor', 'showProjectTitle', 'showSlideNumber'].every(
      (key) => typeof p[key] === 'boolean',
    )
  )
    invalid();
  const checked = structuredClone(value);
  if (p.html !== undefined) {
    if (!text(p.html, 200000)) invalid();
    checked.template.html = sanitizeTemplateHTML(p.html, ownerId, assetScope);
  }
  if (p.css !== undefined) checked.template.css = validateThemeCSS(p.css, ownerId, assetScope);
  if (value.sourceCSS !== undefined)
    checked.sourceCSS = validateThemeCSS(value.sourceCSS, ownerId, assetScope);
  return checked;
}

export function validAssetURL(url, id, scope = 'projects') {
  return (
    typeof url === 'string' &&
    url.startsWith('/api/' + scope + '/' + id + '/assets/') &&
    /^\/api\/(projects|themes)\/[\w-]+\/assets\/[\w.-]+$/.test(url) &&
    !url.includes('..')
  );
}
export function assetReferences(value) {
  return [
    ...new Set(
      JSON.stringify(value).match(/\/api\/(?:projects|themes)\/[\w-]+\/assets\/[\w.-]+/g) || [],
    ),
  ];
}
export function rebaseDesign(value, from, to) {
  return JSON.parse(JSON.stringify(value).split(from).join(to));
}

export function validateThemeCSS(value, id, scope = 'projects') {
  if (!text(value, 200000)) throw badRequest('Некорректный CSS темы.');
  const plain = value
    .replace(/\\([a-f\d]{1,6})\s?/gi, (_, code) =>
      String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)),
    )
    .replace(/\\(.)/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  if (/<|@import|expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i.test(plain))
    throw badRequest('Некорректный CSS темы.');
  for (const match of plain.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const url = match[2].trim();
    if (
      !value.includes(url) ||
      (!validAssetURL(url, id, scope) &&
        !/^\/fonts\/[\w.-]+$/.test(url) &&
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url))
    )
      throw badRequest('CSS может использовать только изображения текущей темы или презентации.');
  }
  try {
    scopeThemeCSS(value, '.presentation-template');
  } catch {
    throw badRequest('Некорректный CSS темы.');
  }
  return value;
}
function sanitizeTemplateHTML(html, id, scope) {
  const { document } = parseHTML('<html><body>' + html + '</body></html>');
  document
    .querySelectorAll('script,iframe,object,embed,base,meta,link,style,form,input,textarea,select')
    .forEach((el) => el.remove());
  const ids = new Set();
  let count = 0;
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(),
        value = attribute.value.trim();
      if (/\{\{/.test(value)) throw badRequest('Переменные шаблона разрешены только в тексте.');
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'action'].includes(name))
        element.removeAttribute(name);
      else if (
        ['src', 'href', 'xlink:href'].includes(name) &&
        !validAssetURL(value, id, scope) &&
        !value.startsWith('#') &&
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)
      )
        element.removeAttribute(name);
      else if (name === 'style') {
        validateThemeCSS('a{' + value + '}', id, scope);
      }
    }
    if (element.hasAttribute('data-template-layer')) element.removeAttribute('data-template-layer');
    const type = /^(H[1-6]|P|SPAN|STRONG|BLOCKQUOTE|PRE|LI)$/.test(element.tagName)
      ? 'text'
      : element.tagName === 'IMG'
        ? 'image'
        : null;
    if (type && !element.hasAttribute('data-block-id'))
      element.setAttribute('data-block-id', 'theme-block-' + ++count);
    if (type && !element.hasAttribute('data-block-type'))
      element.setAttribute('data-block-type', type);
    const blockId = element.getAttribute('data-block-id');
    if (blockId) {
      if (!/^[\w-]{1,100}$/.test(blockId) || ids.has(blockId))
        throw badRequest('Блоки шаблона должны иметь уникальные идентификаторы.');
      ids.add(blockId);
    }
  }
  const result = document.body.innerHTML;
  for (const match of result.matchAll(/\{\{\s*(\w+)\s*\}\}/g))
    if (!templateVariables.includes(match[1]))
      throw badRequest('Неизвестная переменная шаблона: ' + match[1]);
  return result;
}
