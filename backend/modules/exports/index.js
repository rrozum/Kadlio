import { resolveApplicationFile } from '../../http/resources.js';
import { chromium } from 'playwright';
import PptxGenJS from 'pptxgenjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { renderProject } from '../../engine/html/render.js';
import JSZip from 'jszip';
import { exportHTML } from './html.js';
import { pptxTransitionXML } from '../../../shared/addons/motion/runtime.js';
import { normalizeTimeline, incomingTransition } from '../../../shared/presentation/timeline.js';

async function launchBrowser() {
  if (process.env.PRESENTATION_BROWSER_PATH)
    return chromium.launch({
      headless: true,
      executablePath: process.env.PRESENTATION_BROWSER_PATH,
    });
  try {
    return await chromium.launch({ headless: true });
  } catch (initial) {
    for (const channel of ['chrome', 'msedge'])
      try {
        return await chromium.launch({ headless: true, channel });
      } catch {}
    throw new Error(
      'Для экспорта нужен Chromium на сервере. Установите его: npx playwright install chromium. ' +
        initial.message.split('\n')[0],
    );
  }
}
export async function exportPresentation({ root, project, format, assetRoot }) {
  const timeline = normalizeTimeline(project),
    byId = new Map(project.slides.map((slide) => [slide.id, slide]));
  project = {
    ...project,
    timeline,
    slides: timeline.filter((entry) => entry.type === 'slide').map((entry) => byId.get(entry.id)),
  };
  if (format === 'html') return exportHTML({ root, project, assetRoot });
  if (!['pdf', 'pptx'].includes(format)) throw new Error('Неизвестный формат');
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(() => {
      window.__PRESENTATION_EXPORT__ = true;
    });
    const page = await context.newPage(),
      html = await renderProject(root, project);
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'presentation.local') {
        await route.abort();
        return;
      }
      if (url.pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: html });
        return;
      }
      if (assetRoot && /^\/api\/projects\/[\w-]+\/assets\/[\w.-]+$/.test(url.pathname)) {
        try {
          const file = path.basename(url.pathname),
            mime = {
              '.mp4': 'video/mp4',
              '.webm': 'video/webm',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.webp': 'image/webp',
              '.gif': 'image/gif',
            };
          await route.fulfill({
            contentType: mime[path.extname(file)] || 'application/octet-stream',
            body: await readFile(path.join(assetRoot, file)),
          });
        } catch {
          await route.abort();
        }
        return;
      }
      const file = resolveApplicationFile(root, url.pathname);
      if (!file) {
        await route.abort();
        return;
      }
      try {
        const mime = {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.jpg': 'image/jpeg',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        };
        await route.fulfill({
          contentType: mime[path.extname(file)] || 'application/octet-stream',
          body: await readFile(file),
        });
      } catch {
        await route.abort();
      }
    });
    await page.goto('http://presentation.local/', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Статические форматы не запускают пользовательский JS. Из видео берём
    // только первый декодированный кадр или заданный постер.
    await page.evaluate(async () => {
      await Promise.all(
        [...document.querySelectorAll('video')].map(async (video) => {
          video.pause();
          video.muted = true;
          video.controls = false;
          if (video.readyState < 2)
            await Promise.race([
              new Promise((resolve) => {
                video.addEventListener('loadeddata', resolve, { once: true });
                video.addEventListener('error', resolve, { once: true });
              }),
              new Promise((resolve) => setTimeout(resolve, 1500)),
            ]);
          try {
            video.currentTime = 0;
          } catch {}
          video.pause();
        }),
      );
    });
    if (format === 'pdf') return await page.pdf({ printBackground: true, preferCSSPageSize: true });
    await page.addStyleTag({
      content:
        '.deck-area{display:block!important;padding:0!important;height:auto!important}.deck-stage{transform:none!important;box-shadow:none!important}.stage-shell{width:1280px!important;height:720px!important}.toolbar,.progress,.notes-drawer,.annotation-panel,.annotation-layer,.annotation-hint,.toast,.modal{display:none!important}.export-background>*{visibility:hidden!important}',
    });
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'HTML', width: 1280 / 96, height: 720 / 96 });
    pptx.layout = 'HTML';
    pptx.author = (project.design?.metadata?.author ?? project.author) || '';
    pptx.subject = '';
    pptx.title = project.title;
    pptx.lang = 'ru-RU';
    pptx.company = '';
    pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'ru-RU' };
    for (const source of project.slides) {
      await page.evaluate((id) => {
        document
          .querySelectorAll('#deck-stage > .slide')
          .forEach((s) => s.classList.toggle('active', s.id === id));
      }, source.id);
      const element = page.locator('#deck-stage > #' + source.id),
        model = await element.evaluate(extractSlide);
      await element.evaluate((el) => el.classList.add('export-background'));
      const background = await element.screenshot({ type: 'png' });
      await element.evaluate((el) => el.classList.remove('export-background'));
      const slide = pptx.addSlide();
      slide.background = { color: '11181C' };
      slide.addImage({
        data: 'image/png;base64,' + background.toString('base64'),
        x: 0,
        y: 0,
        w: 1280 / 96,
        h: 720 / 96,
      });
      for (const box of model.boxes) {
        const fill = cssColor(box.background),
          gradient = box.gradient.match(/rgba?\([^)]+\)/)?.[0];
        const actual = fill.alpha ? fill : gradient ? cssColor(gradient) : fill;
        actual.alpha *= box.opacity;
        const sides = box.borders.filter(
          (b) => b.width > 0 && b.style !== 'none' && cssColor(b.color).alpha > 0,
        );
        const uniform =
          sides.length === 4 &&
          sides.every((b) => b.width === sides[0].width && b.color === sides[0].color);
        if (actual.alpha || uniform) {
          const options = {
            x: box.x / 96,
            y: box.y / 96,
            w: box.w / 96,
            h: box.h / 96,
            fill: { color: actual.hex, transparency: (1 - actual.alpha) * 100 },
            line: uniform
              ? {
                  color: cssColor(sides[0].color).hex,
                  width: sides[0].width * 0.75,
                  transparency: (1 - cssColor(sides[0].color).alpha) * 100,
                }
              : { transparency: 100 },
            rectRadius: box.radius / 96,
          };
          slide.addShape(
            box.radius >= Math.min(box.w, box.h) / 2
              ? pptx.ShapeType.ellipse
              : box.radius > 0
                ? pptx.ShapeType.roundRect
                : pptx.ShapeType.rect,
            options,
          );
        }
        if (!uniform)
          for (const border of sides) {
            const positions = {
              top: [box.x, box.y, box.w, 0],
              bottom: [box.x, box.y + box.h, box.w, 0],
              left: [box.x, box.y, 0, box.h],
              right: [box.x + box.w, box.y, 0, box.h],
            };
            const [x, y, w, h] = positions[border.side],
              color = cssColor(border.color);
            slide.addShape(pptx.ShapeType.line, {
              x: x / 96,
              y: y / 96,
              w: w / 96,
              h: h / 96,
              line: {
                color: color.hex,
                width: border.width * 0.75,
                transparency: (1 - color.alpha) * 100,
              },
            });
          }
      }
      for (const image of model.images) {
        const picture = await element
          .locator('[data-export-image="' + image.index + '"]')
          .screenshot({ type: 'png' });
        slide.addImage({
          data: 'image/png;base64,' + picture.toString('base64'),
          x: image.x / 96,
          y: image.y / 96,
          w: image.w / 96,
          h: image.h / 96,
        });
      }
      for (const line of model.lines) {
        const runs = line.parts.map((part) => ({
          text: part.text,
          options: {
            fontFace: part.font,
            fontSize: part.fontSize * 0.75,
            bold: part.bold,
            italic: part.italic,
            color: cssColor(part.color).hex,
            charSpacing: part.spacing * 0.75,
          },
        }));
        slide.addText(runs, {
          x: line.x / 96,
          y: line.y / 96,
          w: Math.min(1280 - line.x, line.w + 6) / 96,
          h: (line.h + 2) / 96,
          fontFace: runs[0].options.fontFace,
          fontSize: runs[0].options.fontSize,
          margin: 0,
          breakLine: false,
          valign: 'mid',
          paraSpaceAfterPt: 0,
          wrap: false,
          shapeName: 'HTML text ' + source.id,
        });
      }
      slide.addNotes(source.notes);
    }
    const result = await pptx.write({ outputType: 'nodebuffer', compression: true });
    return applyTimelineTransitions(result, project);
  } finally {
    await browser.close();
  }
}
export async function applyTimelineTransitions(buffer, project) {
  const timeline = normalizeTimeline(project),
    ids = timeline.filter((entry) => entry.type === 'slide').map((entry) => entry.id),
    transitions = ids.map((id) => {
      const effect = incomingTransition({ ...project, timeline }, id);
      return effect?.snippet ? null : pptxTransitionXML(effect);
    });
  if (!transitions.some(Boolean)) return Buffer.from(buffer);
  const zip = await JSZip.loadAsync(buffer);
  for (const [index, transition] of transitions.entries()) {
    if (!transition) continue;
    const file = 'ppt/slides/slide' + (index + 1) + '.xml';
    let xml = await zip.file(file).async('string');
    xml = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>/g, '');
    const insertion = xml.indexOf('<p:timing');
    xml =
      insertion >= 0
        ? xml.slice(0, insertion) + transition + xml.slice(insertion)
        : xml.replace('</p:sld>', transition + '</p:sld>');
    zip.file(file, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export function exportWarnings(project, format) {
  if (!['pdf', 'pptx'].includes(format)) return [];
  const warnings = [];
  if (
    project.slides.some((slide) => slide.script?.trim() || slide.elementEffects?.length) ||
    project.timeline?.some((entry) => entry.snippet)
  )
    warnings.push(
      'JavaScript и JS-эффекты не переносятся: экспортируется сохранённый статичный HTML. Для интерактивного просмотра используйте HTML.',
    );
  if (
    project.design?.background?.type === 'video' ||
    project.slides.some((slide) => /<video\b/i.test(slide.body || ''))
  )
    warnings.push(
      'Видео не воспроизводится в этом экспорте: сохраняется первый доступный кадр или постер.',
    );
  return warnings;
}
function cssColor(value) {
  const numbers = String(value)
    .match(/[\d.]+/g)
    ?.map(Number) || [0, 0, 0, 0];
  return {
    hex: numbers
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase(),
    alpha: numbers.length > 3 ? numbers[3] : 1,
  };
}
// Переносы строк и позиции определяет браузер. В PPTX передаём редактируемые
// текст, карточки и линии; фоновый декор и иллюстрации сохраняем изображениями.
function extractSlide(slide) {
  const origin = slide.getBoundingClientRect(),
    boxes = [],
    images = [],
    segments = [],
    blockIds = new Map();
  const rect = (r) => ({ x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height });
  for (const el of slide.querySelectorAll('*')) {
    const style = getComputedStyle(el),
      r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (el.matches('img,svg,canvas,video')) {
      el.dataset.exportImage = String(images.length);
      images.push({ ...rect(r), index: images.length });
      continue;
    }
    const borders = ['top', 'right', 'bottom', 'left'].map((side) => ({
      side,
      width: parseFloat(style.getPropertyValue('border-' + side + '-width')),
      color: style.getPropertyValue('border-' + side + '-color'),
      style: style.getPropertyValue('border-' + side + '-style'),
    }));
    let opacity = 1;
    for (let parent = el; parent !== slide; parent = parent.parentElement)
      opacity *= Number(getComputedStyle(parent).opacity);
    if (
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
      style.backgroundImage !== 'none' ||
      borders.some((b) => b.width > 0 && b.style !== 'none')
    )
      boxes.push({
        ...rect(r),
        background: style.backgroundColor,
        gradient: style.backgroundImage,
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        borders,
        opacity,
      });
  }
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (parent.closest('svg,script,style')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    let block = parent;
    while (block.parentElement !== slide && getComputedStyle(block).display === 'inline')
      block = block.parentElement;
    if (!blockIds.has(block)) blockIds.set(block, blockIds.size);
    const font = style.fontFamily.split(',')[0].replace(/['"]/g, ''),
      fontSize = parseFloat(style.fontSize),
      bold = Number(style.fontWeight) >= 600,
      italic = style.fontStyle === 'italic',
      spacing = parseFloat(style.letterSpacing) || 0;
    let current = null;
    for (let i = 0; i < node.textContent.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width < 0.01 || r.height < 0.01) continue;
      let char = node.textContent[i];
      if (style.textTransform === 'uppercase') char = char.toUpperCase();
      const position = rect(r);
      if (!current || Math.abs(current.y - position.y) > 1) {
        current = {
          ...position,
          text: char,
          block: blockIds.get(block),
          font,
          fontSize,
          bold,
          italic,
          spacing,
          color: style.color,
        };
        segments.push(current);
      } else {
        current.text += char;
        current.w = position.x + position.w - current.x;
      }
    }
  }
  const lines = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    let line = lines.find((l) => l.block === segment.block && Math.abs(l.y - segment.y) < 1);
    if (!line) {
      line = {
        x: segment.x,
        y: segment.y,
        w: segment.w,
        h: segment.h,
        block: segment.block,
        parts: [],
      };
      lines.push(line);
    }
    line.x = Math.min(line.x, segment.x);
    line.w = Math.max(line.w, segment.x + segment.w - line.x);
    line.h = Math.max(line.h, segment.h);
    line.parts.push(segment);
  }
  lines.forEach((line) => line.parts.sort((a, b) => a.x - b.x));
  return { boxes, images, lines };
}
