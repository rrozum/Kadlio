import { getThemePreset } from './themes.js';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const templateVariables = [
  'author',
  'brand',
  'projectTitle',
  'slideTitle',
  'section',
  'slideNumber',
  'slideCount',
];

export function createPresentationDesign(themeId, project = {}) {
  const preset = getThemePreset(themeId);
  return {
    schemaVersion: 1,
    themeId: preset.id,
    tokens: { ...preset.tokens },
    background: { ...preset.background },
    decorations: preset.decorations.map((item) => ({ ...item })),
    metadata: { author: project.author || '', brand: project.brand || '' },
    template: {
      header: '{{section}}',
      footer: '',
      showAuthor: true,
      showProjectTitle: true,
      showSlideNumber: true,
    },
  };
}
export function resolveTemplate(text, project, slide, index) {
  const values = {
    author: project.design?.metadata?.author ?? project.author ?? '',
    brand: project.design?.metadata?.brand ?? project.brand ?? '',
    projectTitle: project.title || '',
    slideTitle: slide.title || '',
    section: slide.section || '',
    slideNumber: String(index + 1).padStart(2, '0'),
    slideCount: project.slides?.length || 1,
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
export function presentationDesignCSS(design) {
  if (!design) return '.slide-body{position:relative;height:100%;display:flow-root}';
  const { tokens: t, background: b } = design;
  const variables = Object.entries(t)
    .map(([key, value]) => `--pres-${key === 'background' ? 'bg' : key}:${value}`)
    .join(';');
  const bg =
    b.type === 'video'
      ? t.background
      : b.type === 'image'
        ? `url("${b.value}") ${t.background}`
        : b.type === 'gradient'
          ? b.value + ' ' + t.background
          : b.value;
  const palette = `.slide.presentation-designed{${variables};--ink:var(--pres-text);--muted:var(--pres-muted);--blue:var(--pres-accent);isolation:isolate}`;
  const tokens = design.sourceCSS
    ? ''
    : `.slide.presentation-designed{color:var(--pres-text);font-family:var(--pres-font);background:${bg}!important;background-size:cover!important;background-position:center!important}.slide.presentation-designed:before,.slide.presentation-designed:after{display:none!important}.presentation-designed h1,.presentation-designed h2,.presentation-designed h3{color:var(--pres-text);font-family:var(--pres-font)}.presentation-designed .sf-template{--sf-bg:transparent;--sf-fg:var(--pres-text);--sf-accent:var(--pres-accent);background:transparent}.presentation-designed .sf-template:before{display:none}.presentation-designed .soft,.presentation-designed .lead,.presentation-designed .caption,.presentation-designed .eyebrow{color:var(--pres-muted)}`;
  const base = `.presentation-designed .slide-content{position:static!important}.slide-body{position:relative;height:100%;display:flow-root}.presentation-designed .slide-body{z-index:1}.presentation-template{position:absolute;inset:0;z-index:0;pointer-events:none;user-select:none;overflow:hidden}.presentation-template [data-template-text]{position:absolute;z-index:1;font-family:var(--pres-font);color:var(--pres-muted);font-size:14px;line-height:1.3;white-space:pre;overflow:hidden;text-overflow:ellipsis}.presentation-template .template-header{top:30px;left:56px;right:56px;letter-spacing:1px}.presentation-template .template-footer{bottom:55px;left:56px;right:56px;max-width:1168px}.presentation-template .template-author{bottom:25px;left:56px;max-width:330px}.presentation-template .template-title{bottom:25px;left:410px;right:170px;text-align:right;font-size:12px}.presentation-template .template-page{bottom:25px;right:56px;text-align:right;font-variant-numeric:tabular-nums}`;
  return (
    palette +
    tokens +
    scopeThemeCSS(design.sourceCSS || '', '.slide.presentation-designed') +
    base +
    '.presentation-background-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none}' +
    scopeThemeCSS(design.template.css || '', '.presentation-template')
  );
}
export function themeTemplateSource(design) {
  if (!design) return { html: '', css: '' };
  if (design.template.html !== undefined)
    return { html: design.template.html, css: design.template.css || '' };
  const decoration = design.decorations
    .map(
      (d) =>
        `<div aria-hidden="true" data-template-decoration="${escape(d.id)}" data-block-id="decoration-${escape(d.id)}" data-block-type="element" style="position:absolute;left:${d.x}px;top:${d.y}px;width:${d.width}px;height:${d.height}px;background:${d.color};opacity:${d.opacity};${d.type === 'circle' ? 'border-radius:50%;' : ''}${d.rotation ? `transform:rotate(${d.rotation}deg);` : ''}"></div>`,
    )
    .join('');
  const text = (className, value) =>
    value
      ? `<div data-template-text data-block-id="${className}" data-block-type="text" class="${className}">${escape(value)}</div>`
      : '';
  const t = design.template;
  return {
    html:
      decoration +
      text('template-header', t.header) +
      text('template-footer', t.footer) +
      (t.showAuthor ? text('template-author', '{{author}}') : '') +
      (t.showProjectTitle ? text('template-title', '{{projectTitle}}') : '') +
      (t.showSlideNumber ? text('template-page', '{{slideNumber}} / {{slideCount}}') : ''),
    css: t.css || '',
  };
}
export function renderPresentationTemplate(project, slide, index = 0) {
  if (!project.design) return '';
  const source = themeTemplateSource(project.design).html;
  const rendered = source.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    templateVariables.includes(key) ? escape(resolveTemplate(match, project, slide, index)) : match,
  );
  const b = project.design.background,
    video =
      b.type === 'video'
        ? `<video class="presentation-background-video" src="${escape(b.value)}" ${b.poster ? `poster="${escape(b.poster)}"` : ''} autoplay loop muted playsinline aria-hidden="true"></video>`
        : '';
  return `<div data-template-layer class="presentation-template" aria-label="Общий шаблон слайда">${video}${rendered}</div>`;
}
export function renderThemePreview(theme, context = {}) {
  const design = structuredClone(theme.design || theme),
    project = {
      title: context.projectTitle || 'Название презентации',
      design,
      slides: Array.from({ length: context.slideCount || 12 }, () => ({})),
    };
  design.metadata = {
    ...design.metadata,
    author: context.author ?? (design.metadata.author || 'Автор'),
    brand: context.brand ?? (design.metadata.brand || 'Название команды'),
  };
  const slide = {
    title: context.slideTitle || 'Пример слайда',
    section: context.section || 'РАЗДЕЛ',
  };
  return {
    html: `<section class="slide presentation-designed active" style="width:1280px;height:720px;position:relative;overflow:hidden">${renderPresentationTemplate(project, slide, (context.slideNumber || 1) - 1)}</section>`,
    css: presentationDesignCSS(design),
  };
}
export function renderSlideBody(project, slide, index = 0) {
  return `${renderPresentationTemplate(project, slide, index)}<div class="slide-body">${slide.body || ''}</div>`;
}

// Ограничиваем CSS областью слайда или шаблона. Вложенные media/supports rules
// сохраняются; объявления и значения переменных не переписываются.
export function scopeThemeCSS(css, scope) {
  let output = '',
    offset = 0;
  css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  while (offset < css.length) {
    const start = css.indexOf('{', offset);
    if (start < 0) {
      if (css.slice(offset).trim()) throw new Error('Некорректный CSS шаблона.');
      break;
    }
    const head = css.slice(offset, start).trim();
    let end = start + 1,
      depth = 1,
      quote = '';
    for (; end < css.length && depth; end++) {
      const char = css[end];
      if (quote) {
        if (char === '\\') end++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth) throw new Error('Некорректный CSS шаблона.');
    const contents = css.slice(start + 1, end - 1);
    offset = end;
    if (/^@(media|supports|container)\b/i.test(head)) {
      output += `${head}{${scopeThemeCSS(contents, scope)}}`;
      continue;
    }
    if (/^@(?:-webkit-)?keyframes\b|^@font-face\b/i.test(head)) {
      output += `${head}{${contents}}`;
      continue;
    }
    if (head.startsWith('@')) throw new Error('Неподдерживаемое правило CSS.');
    const selectors = head.split(/,(?![^()]*\))/).flatMap((selector) => {
      let value = selector
        .trim()
        .replace(/^(?:(?:html|body|:root)\s*)+/, '')
        .trim();
      if (!value) return [scope];
      if (value.startsWith(scope)) return [value];
      if (scope === '.slide.presentation-designed' && /^\.slide\b/.test(value))
        return [value.replace(/^\.slide\b/, scope)];
      return [scope + ' ' + value, ...(/^[.#[]/.test(value) ? [scope + value] : [])];
    });
    output += `${selectors.join(',')}{${contents}}`;
  }
  return output;
}
