import JSZip from 'jszip';

const escape = (text) =>
  String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[c],
    );

// Поддерживаем обычный linear-gradient; сложные CSS-фоны остаются ограничением native PPTX.
export function gradientFill(value, opacity = 1, background = 'rgba(0, 0, 0, 0)') {
  if (!value.startsWith('linear-gradient(') || !value.endsWith(')')) return null;
  const parts = value
    .slice(16, -1)
    .split(/,(?![^()]*\))/)
    .map((part) => part.trim());
  let angle = 180;
  if (/^-?[\d.]+deg$/.test(parts[0])) angle = parseFloat(parts.shift());
  else if (parts[0].startsWith('to ')) {
    angle = {
      'to top': 0,
      'to right': 90,
      'to bottom': 180,
      'to left': 270,
      'to top right': 45,
      'to bottom right': 135,
      'to bottom left': 225,
      'to top left': 315,
    }[parts.shift()];
  }
  if (!Number.isFinite(angle) || parts.length < 2) return null;
  const stops = parts.map((part) => {
    const match = /^(rgba?\([^)]+\))(?:\s+(-?[\d.]+)%)?$/.exec(part);
    if (!match) return null;
    const rgba = match[1].match(/[\d.]+/g).map(Number);
    const base = background.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
    const alpha = rgba[3] ?? 1,
      baseAlpha = (base[3] ?? 1) * (1 - alpha),
      combined = alpha + baseAlpha;
    return {
      rgb: rgba
        .slice(0, 3)
        .map((channel, index) =>
          combined ? (channel * alpha + base[index] * baseAlpha) / combined : 0,
        )
        .map((n) => Math.round(n).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
      alpha: combined * opacity,
      position: match[2] == null ? null : Number(match[2]) / 100,
    };
  });
  if (stops.some((stop) => !stop)) return null;
  stops[0].position ??= 0;
  stops.at(-1).position ??= 1;
  let previous = 0;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].position == null) continue;
    stops[i].position = Math.max(stops[previous].position, stops[i].position);
    for (let j = previous + 1; j < i; j++)
      stops[j].position =
        stops[previous].position +
        ((stops[i].position - stops[previous].position) * (j - previous)) / (i - previous);
    previous = i;
  }
  if (stops.some((stop) => stop.position < 0 || stop.position > 1)) return null;
  return (
    '<a:gradFill rotWithShape="1"><a:gsLst>' +
    stops
      .map(
        (stop) =>
          `<a:gs pos="${Math.round(stop.position * 100000)}"><a:srgbClr val="${stop.rgb}"><a:alpha val="${Math.round(stop.alpha * 100000)}"/></a:srgbClr></a:gs>`,
      )
      .join('') +
    `</a:gsLst><a:lin ang="${Math.round(((((angle - 90) % 360) + 360) % 360) * 60000)}" scaled="1"/></a:gradFill>`
  );
}

export async function finalizePptx(buffer, project, models, fonts) {
  const zip = await JSZip.loadAsync(buffer);
  for (const [index, source] of project.slides.entries()) {
    const filename = `ppt/slides/slide${index + 1}.xml`;
    let xml = await zip.file(filename).async('string');
    xml = xml.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (tag, text) =>
      /^\s|\s$| {2}|\t/.test(text) ? `<a:t xml:space="preserve">${text}</a:t>` : tag,
    );
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => {
      const id = /name="HTML box (\d+)"/.exec(shape)?.[1];
      const box = id == null ? null : models[index].boxes[Number(id)];
      const gradient = box && gradientFill(box.gradient, box.opacity, box.background);
      if (!gradient) return shape;
      return shape.replace(
        /(<p:spPr>[\s\S]*?<\/a:prstGeom>)([\s\S]*?)(?=<a:ln\b|<\/p:spPr>)/,
        (_, start) => start + gradient,
      );
    });
    zip.file(filename, xml);
    const notesFile = `ppt/notesSlides/notesSlide${index + 1}.xml`;
    let notes = await zip.file(notesFile).async('string');
    const paragraphs = String(source.notes ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(
        (line) =>
          `<a:p><a:r><a:rPr lang="ru-RU" sz="1400"/><a:t xml:space="preserve">${escape(line)}</a:t></a:r><a:endParaRPr lang="ru-RU" sz="1400"/></a:p>`,
      )
      .join('');
    notes = notes.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) =>
      shape.includes('<p:ph type="body"')
        ? shape.replace(
            /<p:txBody>[\s\S]*?<\/p:txBody>/,
            `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`,
          )
        : shape,
    );
    zip.file(notesFile, notes);
  }
  let types = await zip.file('[Content_Types].xml').async('string');
  // PptxGenJS 4 объявляет master для каждого слайда, но создает только slideMaster1.
  types = types.replace(
    /<Override\b[^>]*PartName="(\/ppt\/slideMasters\/slideMaster\d+\.xml)"[^>]*\/>/g,
    (tag, name) => (zip.file(name.slice(1)) ? tag : ''),
  );
  const families = new Map();
  let rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string'),
    presentation = await zip.file('ppt/presentation.xml').async('string'),
    totalBytes = 0;
  let nextId = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  for (const font of fonts.values()) {
    if (!font) continue;
    const slot = font.bold
      ? font.italic
        ? 'boldItalic'
        : 'bold'
      : font.italic
        ? 'italic'
        : 'regular';
    if (!families.has(font.family)) families.set(font.family, new Map());
    const slots = families.get(font.family);
    if (slots.has(slot) || totalBytes + font.data.length > 32 * 1024 * 1024) continue;
    const id = 'rId' + nextId++,
      target = `fonts/font${nextId}.fntdata`;
    zip.file('ppt/' + target, font.data);
    totalBytes += font.data.length;
    slots.set(slot, id);
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${target}"/></Relationships>`,
    );
  }
  if ([...families.values()].some((slots) => slots.size)) {
    const embedded =
      '<p:embeddedFontLst>' +
      [...families]
        .map(
          ([family, slots]) =>
            `<p:embeddedFont><p:font typeface="${escape(family)}"/>` +
            ['regular', 'bold', 'italic', 'boldItalic']
              .filter((slot) => slots.has(slot))
              .map((slot) => `<p:${slot} r:id="${slots.get(slot)}"/>`)
              .join('') +
            '</p:embeddedFont>',
        )
        .join('') +
      '</p:embeddedFontLst>';
    presentation = presentation
      .replace(/<p:presentation\b[^>]*>/, (tag) =>
        tag
          .replace(/\s(?:embedTrueTypeFonts|saveSubsetFonts)="[^"]*"/g, '')
          .replace(
            '<p:presentation ',
            '<p:presentation embedTrueTypeFonts="1" saveSubsetFonts="0" ',
          ),
      )
      .replace(
        /(?=<p:(?:custShowLst|photoAlbum|custDataLst|kinsoku|defaultTextStyle|modifyVerifier|extLst)\b|<\/p:presentation>)/,
        embedded,
      );
    types = types.replace(
      '</Types>',
      '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>',
    );
  }
  zip.file('[Content_Types].xml', types);
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', rels);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
