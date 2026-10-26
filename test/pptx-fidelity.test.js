import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Library } from '../backend/application/engine.js';
import { exportPresentation } from '../backend/modules/exports/index.js';
import { encodeEot } from '../backend/modules/exports/pptx-fonts.js';
import { gradientFill } from '../backend/modules/exports/pptx-package.js';
import { projectRoot as root } from '../backend/http/server.js';

test('PPTX keeps inline positions, whitespace, decoration, gradients, generated text, fonts and note paragraphs', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pptx-fidelity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = await new Library(directory).init(),
    project = await library.create({ title: 'Export fidelity', blank: true });
  await library.updateCSS(project.id, {
    version: project.version,
    css: `
    .slide{background:#112233!important}
    .slide .slide-content{position:absolute;inset:0;padding:0}
    .slide .generated::before{content:"Вопросы / 5–10 минут";position:absolute;left:60px;top:30px;color:#ffffff;font:16px Arial}
  `,
  });
  await library.updateSlide(project.id, project.slides[0].id, {
    version: 0,
    body: `
    <div class="generated"></div>
    <div style="position:absolute;left:60px;top:100px;width:600px;height:90px;background:linear-gradient(135deg,rgba(255,0,102,.7) 10%,rgb(0,170,255) 80%);border-radius:16px"></div>
    <pre style="position:absolute;left:60px;top:230px;font:22px 'Missing Export Font',monospace;color:white;margin:0">Root::run()
    → <b>Child::save()</b>
\t→ Tab::run()</pre>
    <div style="position:absolute;left:60px;top:350px;font:28px Arial;color:white;text-decoration:line-through rgba(255,0,102,.7) 2px"><span>(10 + 30) / 2 = 20</span></div>
    <div style="position:absolute;left:60px;top:440px;font:28px Arial;color:white">Факт<span style="color:#00aaff"> → расчет</span></div>
    <div style="position:absolute;left:60px;top:510px;font:28px Arial;color:#00aaff;text-decoration:underline">Трасса T01</div>
    <div style="position:absolute;left:60px;top:580px;font:20px Arial;color:white">Карта <code style="font-family:monospace">very-long-feature-architecture-skill</code></div>
  `,
  });
  const source = await library.get(project.id);
  source.slides[0].notes = 'Первый абзац.\n\n  Второй абзац с отступом.\nТретья строка <&>.\n';
  const second = {
    ...source.slides[0],
    id: 'slide-second',
    title: 'Second',
    notes: 'Other notes',
    body: '<h1>Второй слайд</h1>',
  };
  source.slides.push(second);
  source.timeline = [
    { type: 'slide', id: source.slides[0].id },
    { type: 'slide', id: second.id },
  ];
  const before = JSON.stringify(source),
    zip = await JSZip.loadAsync(
      await exportPresentation({ root, project: source, format: 'pptx' }),
    );
  assert.equal(JSON.stringify(source), before, 'Export must not change the input project');
  const xml = await zip.file('ppt/slides/slide1.xml').async('string'),
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  const shapes = [...doc.getElementsByTagName('p:sp')];
  const textShape = (text) =>
    shapes.find((s) =>
      [...s.getElementsByTagName('a:t')].some((node) => node.textContent === text),
    );
  assert.ok(textShape('Вопросы / 5–10 минут'), 'Generated CSS text remains editable');
  assert.ok(textShape('    → '), 'Preformatted indentation survives');
  assert.equal(
    textShape('    → ').getElementsByTagName('a:t')[0].getAttribute('xml:space'),
    'preserve',
  );
  const inline = textShape(' → расчет');
  assert.ok(inline, 'Leading inline whitespace survives');
  const x = (shape) => Number(shape.getElementsByTagName('a:off')[0].getAttribute('x'));
  assert.ok(
    x(textShape('→ Tab::run()')) > 60 * 9525,
    'CSS tabs become measured gaps, not Office tab stops',
  );
  assert.ok(x(inline) > x(textShape('Факт')), 'Inline parts keep independent positions');
  assert.ok(textShape('(10 + 30) / 2 = 20'));
  assert.match(
    xml,
    /<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0066"><a:alpha val="70000"\/>/,
    'Inherited CSS strike is an editable colored line',
  );
  assert.equal(doc.getElementsByTagName('a:gradFill').length, 1);
  assert.match(xml, /<a:gs pos="10000">/);
  assert.match(xml, /<a:gs pos="80000">/);
  assert.doesNotMatch(xml, /Missing Export Font/);
  assert.notEqual(
    textShape('Карта ').getElementsByTagName('a:latin')[0].getAttribute('typeface'),
    textShape('very-long-feature-architecture-skill')
      .getElementsByTagName('a:latin')[0]
      .getAttribute('typeface'),
    'A longer child code must not replace its parent label font',
  );
  assert.equal(
    doc.getElementsByTagName('p:pic').length,
    1,
    'Only the decorative background is a picture',
  );
  const background = await loadImage(await zip.file('ppt/media/image-1-1.png').async('nodebuffer'));
  const canvas = createCanvas(background.width, background.height),
    context = canvas.getContext('2d');
  context.drawImage(background, 0, 0);
  const region = context.getImageData(100, 40, 700, 100).data;
  let white = 0;
  for (let i = 0; i < region.length; i += 4)
    if (region[i] > 220 && region[i + 1] > 220 && region[i + 2] > 220) white++;
  assert.equal(white, 0, 'Generated white text must not also be burned into the background');
  const notes = new DOMParser().parseFromString(
    await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'),
    'text/xml',
  );
  const body = [...notes.getElementsByTagName('p:sp')].find(
    (s) => s.getElementsByTagName('p:ph')[0]?.getAttribute('type') === 'body',
  );
  assert.equal(
    [...body.getElementsByTagName('a:p')].map((p) => p.textContent).join('\n'),
    source.slides[0].notes,
  );
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.doesNotMatch(types, /slideMaster2\.xml/);
  const fontParts = Object.keys(zip.files).filter((name) => name.endsWith('.fntdata'));
  assert.ok(fontParts.length >= 2, 'Actual system fonts are embedded, including bold');
  for (const name of fontParts) {
    const font = await zip.file(name).async('nodebuffer');
    assert.equal(font.readUInt32LE(0), font.length);
    assert.equal(font.readUInt16LE(34), 0x504c);
    assert.equal(font.readUInt32BE(font.length - font.readUInt32LE(4)), 0x10000);
  }
  assert.match(await zip.file('ppt/presentation.xml').async('string'), /saveSubsetFonts="0"/);
  assert.equal(
    (await zip.file('ppt/presentation.xml').async('string')).match(/saveSubsetFonts=/g).length,
    1,
  );
});

test('EOT respects editable embedding permissions and rejects malformed font input', async () => {
  const file = execFileSync('fc-match', ['-f', '%{file}', 'sans-serif'], { encoding: 'utf8' });
  const data = await readFile(file),
    original = encodeEot(data);
  assert.ok(original.data.length > data.length);
  let os2;
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    if (data.toString('ascii', at, at + 4) === 'OS/2') os2 = data.readUInt32BE(at + 8);
  }
  assert.ok(os2);
  for (const bits of [2, 4, 0x200]) {
    const restricted = Buffer.from(data);
    restricted.writeUInt16BE(bits, os2 + 8);
    assert.throws(() => encodeEot(restricted), /disallows/);
  }
  const editable = Buffer.from(data);
  editable.writeUInt16BE(8 | 0x100, os2 + 8);
  assert.equal(encodeEot(editable).data.readUInt32LE(4), data.length, 'No font subsetting');
  assert.throws(() => encodeEot(Buffer.alloc(10)), /Unsupported/);
  const malformed = Buffer.from(data);
  malformed.writeUInt32BE(0xffffffff, 20);
  assert.throws(() => encodeEot(malformed), /Invalid font table/);
});

test('linear gradients keep direction, alpha and interpolated stops; unsupported fills are explicit', () => {
  const xml = gradientFill(
    'linear-gradient(90deg, rgba(255, 0, 0, 0.5), rgb(0, 255, 0), rgb(0, 0, 255))',
    0.5,
  );
  assert.match(xml, /pos="50000"/);
  assert.match(xml, /alpha val="25000"/);
  assert.match(xml, /ang="0"/);
  assert.match(
    gradientFill('linear-gradient(-450deg, rgb(255, 0, 0), rgb(0, 0, 255))'),
    /ang="10800000"/,
  );
  assert.match(
    gradientFill(
      'linear-gradient(90deg, rgba(255, 0, 0, 0.5), rgba(255, 0, 0, 0.5))',
      1,
      'rgb(0, 0, 255)',
    ),
    /val="800080"/,
  );
  assert.equal(gradientFill('radial-gradient(rgb(0,0,0), rgb(255,255,255))'), null);
});
