// Только текстовые псевдоэлементы становятся DOM-текстом; декоративные остаются фоном.
export function materializePseudoText(slide) {
  if (!document.getElementById('pptx-pseudo-text')) {
    const css = document.createElement('style');
    css.id = 'pptx-pseudo-text';
    css.textContent =
      '[data-export-before]::before,[data-export-after]::after{content:none!important}';
    document.head.append(css);
  }
  for (const element of [slide, ...slide.querySelectorAll('*')]) {
    if (element.closest('svg,script,style')) continue;
    for (const side of ['before', 'after']) {
      const computed = getComputedStyle(element, '::' + side),
        content = computed.content;
      if (!content || ['none', 'normal', '""'].includes(content) || content.includes('url('))
        continue;
      const tokens = content.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g);
      if (!tokens) continue;
      const text = tokens
        .map((token) =>
          token
            .slice(1, -1)
            .replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex, char) =>
              hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
            ),
        )
        .join('');
      if (!text) continue;
      const span = document.createElement('span');
      for (const property of computed)
        span.style.setProperty(property, computed.getPropertyValue(property));
      span.style.content = 'normal';
      span.textContent = text;
      element.setAttribute('data-export-' + side, '');
      if (side === 'before') element.prepend(span);
      else element.append(span);
    }
  }
}

// Переносы строк и позиции определяет браузер. В PPTX передаем редактируемые
// текст, карточки и линии; фоновый декор и иллюстрации сохраняем изображениями.
export function extractSlide(slide) {
  const origin = slide.getBoundingClientRect(),
    boxes = [],
    images = [],
    segments = [],
    blockIds = new Map();
  const rect = (r) => ({
    x: r.x - origin.x,
    y: r.y - origin.y,
    w: r.width,
    h: r.height,
  });
  for (const el of slide.querySelectorAll('*')) {
    const style = getComputedStyle(el),
      r = el.getBoundingClientRect();
    if (
      !r.width ||
      !r.height ||
      style.visibility === 'hidden' ||
      (el.closest('svg') && !el.matches('svg'))
    )
      continue;
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
        ellipse:
          (style.borderTopLeftRadius.includes('%') &&
            parseFloat(style.borderTopLeftRadius) >= 50) ||
          (Math.abs(r.width - r.height) < 0.01 &&
            parseFloat(style.borderTopLeftRadius) >= r.width / 2),
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
    if (!parent.dataset.exportFont)
      parent.dataset.exportFont = String(blockIds.size) + '-' + segments.length;
    let opacity = 1;
    const decorations = [];
    for (let el = parent; el && el !== slide; el = el.parentElement) {
      const computed = getComputedStyle(el);
      opacity *= Number(computed.opacity);
      if (computed.textDecorationLine !== 'none')
        decorations.push({
          line: computed.textDecorationLine,
          color: computed.textDecorationColor,
          thickness:
            parseFloat(computed.textDecorationThickness) || parseFloat(style.fontSize) / 16,
        });
    }
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
      // У Office другие tab stops: переносим табуляцию расстоянием между объектами.
      if (char === '\t') {
        current = null;
        continue;
      }
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
          opacity,
          decorations,
          fontKey: parent.dataset.exportFont,
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
