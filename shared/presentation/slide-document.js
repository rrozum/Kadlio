import { escapeHTML } from './html.js';
import { presentationDesignCSS, renderSlideBody } from './design.js';

export function slideDocument(slide, project = {}, options = {}) {
  const theme = project.themeUrl || '/deck.css';
  const index = Math.max(
    0,
    (project.slides || []).findIndex((item) => item.id === slide.id),
  );
  const total = project.slides?.length || 1;
  const footer =
    project.author || project.brand
      ? `<footer class="footer"><strong>${escapeHTML(project.author || '')}</strong><span class="footer-center">${escapeHTML(project.brand || '')}</span><span class="page-number">${String(index + 1).padStart(2, '0')} / ${total}</span></footer>`
      : '';
  const label = slide.section
    ? `<div class="section-label">${escapeHTML(slide.section)}</div>`
    : '';
  const projectCSS = String(project.css || '').replace(/<\/style/gi, '<\\/style');
  const designCSS = presentationDesignCSS(project.design).replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' data: blob:; script-src 'none'; form-action 'none'; base-uri 'none'"><link rel="stylesheet" href="${escapeHTML(theme)}"><style>${projectCSS}</style><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden}.slide{display:block!important;position:relative!important;isolation:isolate}.slide-content{position:relative}[data-block-id]{box-sizing:border-box}img{user-select:none;-webkit-user-drag:none}${options.editor ? '[contenteditable=true]{outline:1.5px dashed #63c8ff;outline-offset:5px;cursor:text!important}body{user-select:none}[contenteditable=true]{user-select:text}' : ''}</style><style>${designCSS}</style></head><body><section class="slide ${project.design ? 'presentation-designed ' : ''}${escapeHTML(slide.layout || '')}" aria-label="${escapeHTML(slide.title || 'Слайд')}">${project.design ? '' : label}<div class="slide-content">${renderSlideBody(project, slide, index)}</div>${project.design ? '' : footer}</section></body></html>`;
}
