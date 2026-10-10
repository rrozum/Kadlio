/**
 * Шаблоны титульного слайда, содержимого и палитры адаптированы из SlideForge.
 * Upstream: vincenzo-afk/SlideForge @ f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f
 * Источники: js/slides.js (renderSlide/applyTheme), js/ai.js (FALLBACK_THEMES).
 * Copyright (c) 2026 Vincenzo AFK. MIT; see THIRD_PARTY_NOTICES.md.
 * Изменения: ES modules, экранирование текста, стабильные ID блоков, CSS для
 * холста 1280×720, редактируемые позиции и палитра, совместимая с просмотрщиком.
 */

export const palettes = Object.freeze({
  midnight: Object.freeze({
    background: '#0f172a',
    foreground: '#e2e8f0',
    accent: '#199af0',
    secondary: '#eb238d',
  }),
  coral: Object.freeze({
    background: '#fff7ed',
    foreground: '#1c1917',
    accent: '#f43f5e',
    secondary: '#fda4af',
  }),
  forest: Object.freeze({
    background: '#f0fdf4',
    foreground: '#14532d',
    accent: '#16a34a',
    secondary: '#86efac',
  }),
});

function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

/** Полный HTML слайда; title/subtitle/author передаются как обычный текст. */
export function createTitleSlide(title, { subtitle = '', author = '' } = {}) {
  return `<div class="sf-template sf-title">
  <h1 data-block-id="title" data-block-type="text" style="position:absolute;left:72px;top:156px;width:1090px;height:190px">${escapeText(title)}</h1>
  ${subtitle ? `<p data-block-id="subtitle" data-block-type="text" class="sf-subtitle" style="position:absolute;left:76px;top:398px;width:1050px;height:86px">${escapeText(subtitle)}</p>` : ''}
  ${author ? `<p data-block-id="author" data-block-type="text" class="sf-author" style="position:absolute;left:76px;top:590px;width:1050px;height:40px">${escapeText(author)}</p>` : ''}
</div>`;
}

/** Первые восемь кратких тезисов становятся отдельными редактируемыми HTML-блоками. */
export function createContentSlide(title, bullets = []) {
  const points = Array.isArray(bullets) ? bullets.slice(0, 8) : [];
  return `<div class="sf-template sf-content">
  <h2 data-block-id="title" data-block-type="text" style="position:absolute;left:72px;top:84px;width:1090px;height:114px">${escapeText(title)}</h2>
  <ul class="sf-bullets">${points
    .map(
      (point, index) => `
    <li data-block-id="point-${index + 1}" data-block-type="text" style="position:absolute;left:100px;top:${238 + index * 50}px;width:1030px;height:46px">${escapeText(point)}</li>`,
    )
    .join('')}
  </ul>
</div>`;
}

/** Стили ограничены шаблонами слайдов и не меняют интерфейс приложения. */
export function createThemeCSS(palette = 'midnight') {
  const colors = palettes[palette] || palettes.midnight;
  return `.slide:has(.sf-template) { padding:0; }
.sf-template {
  --sf-bg:${colors.background}; --sf-fg:${colors.foreground};
  --sf-accent:${colors.accent}; --sf-secondary:${colors.secondary};
  position:absolute; inset:0; color:var(--sf-fg); background:var(--sf-bg);
  font-family:Arial,Helvetica,sans-serif; overflow:hidden;
}
.sf-template::before {
  content:""; position:absolute; right:-120px; top:-270px; width:760px; height:760px;
  border:3px solid var(--sf-accent); border-radius:50%; opacity:.25; pointer-events:none;
}
.sf-template h1,.sf-template h2,.sf-template p,.sf-template li {
  margin:0; box-sizing:border-box; overflow-wrap:break-word; line-height:1.14;
}
.sf-template h1 { font-size:68px; font-weight:700; letter-spacing:-2px; }
.sf-template h2 { font-size:54px; font-weight:700; letter-spacing:-1.3px; }
.sf-template .sf-subtitle { font-size:30px; line-height:1.4; opacity:.82; }
.sf-template .sf-author { font-size:22px; color:var(--sf-accent); }
.sf-template .sf-bullets { margin:0; padding:0; }
.sf-template li { font-size:30px; line-height:1.35; list-style-type:disc; }
.sf-template li::marker { color:var(--sf-accent); }
`;
}
