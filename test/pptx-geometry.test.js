import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import JSZip from 'jszip';
import { parseHTML } from 'linkedom';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Library } from '../backend/application/engine.js';
import { exportPresentation } from '../backend/modules/exports/index.js';
import { projectRoot as root } from '../backend/http/server.js';

test('native PPTX ellipses omit unsupported rect adjustment guides while rounded rectangles and text stay editable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pptx-geometry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = await new Library(directory).init(),
    project = await library.create({
      title: 'Native shape geometry',
      blank: true,
    });
  await library.updateCSS(project.id, {
    version: project.version,
    css: '.slide .slide-content{position:absolute;inset:0;padding:0}',
  });
  await library.updateSlide(project.id, project.slides[0].id, {
    version: 0,
    body: '<h1 style="position:absolute;left:80px;top:40px;font-size:36px">Фигуры остаются редактируемыми</h1><div data-block-id="circle" style="position:absolute;left:80px;top:180px;width:140px;height:140px;border-radius:70px;background:#7c3aed"></div><div data-block-id="pill" style="position:absolute;left:270px;top:190px;width:160px;height:18px;border-radius:9px;background:#7c3aed"></div><div data-block-id="rounded" style="position:absolute;left:480px;top:180px;width:220px;height:140px;border-radius:18px;background:#ede8ff;border:2px solid #7c3aed"></div><div data-block-id="rect" style="position:absolute;left:760px;top:180px;width:220px;height:140px;background:#ede8ff"></div>',
  });
  const current = await library.get(project.id),
    before = JSON.stringify(current),
    zip = await JSZip.loadAsync(
      await exportPresentation({ root, project: current, format: 'pptx' }),
    ),
    xml = await zip.file('ppt/slides/slide1.xml').async('string'),
    document = parseHTML(xml).document;
  const ellipses = [...document.querySelectorAll('a\\:prstGeom[prst="ellipse"]')];
  assert.equal(ellipses.length, 1, 'A circle stays an ellipse, a pill uses a rounded rectangle');
  for (const ellipse of ellipses) assert.equal(ellipse.querySelectorAll('a\\:gd').length, 0);
  const rounded = [...document.querySelectorAll('a\\:prstGeom[prst="roundRect"]')];
  assert.equal(rounded.length, 2);
  assert.equal(rounded[0].querySelector('a\\:gd').getAttribute('fmla'), 'val 50000');
  assert.equal(rounded[0].querySelector('a\\:gd').getAttribute('name'), 'adj');
  assert.match(xml, /Фигуры остаются редактируемыми/);
  assert.match(xml, /<p:sp>/);
  assert.equal(JSON.stringify(await library.get(project.id)), before);
});

test('PPTX media capture excludes overlapping HTML nodes while SVG markers and editable labels remain', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pptx-media-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = await new Library(directory).init(),
    project = await library.create({
      title: 'SVG under HTML nodes',
      blank: true,
    });
  await library.updateCSS(project.id, {
    version: project.version,
    css: '.slide .slide-content{position:absolute;inset:0;padding:0}',
  });
  await library.updateSlide(project.id, project.slides[0].id, {
    version: 0,
    body: '<svg data-block-id="connector" viewBox="0 0 600 400" width="600" height="400" style="position:absolute;left:100px;top:150px;z-index:1"><defs><marker id="isolation-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#7c3aed"/></marker></defs><path d="M30 40H530" stroke="#7c3aed" stroke-width="4" marker-end="url(#isolation-arrow)"/><g style="visibility:hidden"><rect x="30" y="100" width="120" height="70" fill="#ff0000"/><text x="30" y="160" font-size="28">Скрытая подпись</text></g><text x="30" y="350" font-size="28" fill="#241b3f">SVG подпись</text></svg><div data-block-id="node" style="position:absolute;left:220px;top:260px;width:180px;height:70px;background:#00ff00;z-index:3;display:flex;align-items:center;justify-content:center"><span style="font-size:28px;font-weight:700">HTML узел</span></div>',
  });
  const current = await library.get(project.id),
    before = JSON.stringify(current),
    zip = await JSZip.loadAsync(
      await exportPresentation({ root, project: current, format: 'pptx' }),
    ),
    xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.equal((xml.match(/<p:pic>/g) || []).length, 2);
  assert.equal((xml.match(/<a:t>HTML узел<\/a:t>/g) || []).length, 1);
  assert.match(xml, /00FF00/);
  const media = await loadImage(await zip.file('ppt/media/image-1-2.png').async('nodebuffer')),
    canvas = createCanvas(media.width, media.height),
    context = canvas.getContext('2d');
  context.drawImage(media, 0, 0);
  assert.equal(media.width, 1200);
  assert.equal(media.height, 800);
  assert.equal(
    context.getImageData(320, 260, 1, 1).data[3],
    0,
    'The SVG picture must not contain its overlapping HTML node or canvas background',
  );
  assert.equal(
    context.getImageData(140, 240, 1, 1).data[3],
    0,
    'Originally hidden SVG descendants must remain unpainted',
  );
  const marker = [...context.getImageData(1020, 80, 1, 1).data];
  assert.ok(marker[0] > 70 && marker[0] < 160 && marker[2] > 180 && marker[3] === 255);
  let textInk = 0;
  const pixels = context.getImageData(50, 620, 400, 100).data;
  for (let index = 0; index < pixels.length; index += 4)
    if (pixels[index + 3] > 200 && pixels[index] < 100) textInk++;
  assert.ok(textInk > 200, 'SVG text remains part of the isolated image');
  assert.equal(JSON.stringify(await library.get(project.id)), before);
});
