import { renderThemePreview } from './design.js';

export function themePreviewDocument(theme, context = {}) {
  const preview = renderThemePreview(theme, context);
  preview.html = preview.html.replace(
    /<\/section>\s*$/,
    '<div aria-hidden="true" style="position:absolute;left:88px;top:190px;width:1020px;z-index:1;font-family:var(--pres-font);color:var(--pres-text)"><div style="width:64px;height:6px;background:var(--pres-accent);margin-bottom:24px;border-radius:3px"></div><h2 style="font:600 62px/1.12 var(--pres-font);margin:0;color:var(--pres-text)">Ключевая мысль</h2><p style="font:28px/1.5 var(--pres-font);margin:24px 0 0;color:var(--pres-muted)">Простой слайд. Одна понятная идея.</p></div></section>',
  );
  const css = String(preview.css || '').replace(/<\/style/gi, '<\\/style');
  return (
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; script-src 'none'; form-action 'none'; base-uri 'none'\"><link rel=\"stylesheet\" href=\"/deck.css\"><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden}.slide{display:block!important;position:relative!important;inset:auto;width:1280px;height:720px}</style><style>" +
    css +
    '</style></head><body>' +
    preview.html +
    '</body></html>'
  );
}
