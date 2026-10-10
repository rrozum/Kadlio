// Блоки работают прямо с HTML. Для нового типа нужны запись в реестре,
// функция create и при необходимости контролы; отдельного формата сцены нет.
export const blockModules = new Map();
export function registerBlockModule(module) {
  if (!module.id || typeof module.create !== 'function')
    throw new Error('A block module needs id and create');
  if (blockModules.has(module.id)) throw new Error('Block module already registered: ' + module.id);
  blockModules.set(module.id, module);
}
registerBlockModule({
  id: 'text',
  label: 'Текст',
  create(doc, options = {}) {
    const element = doc.createElement('p');
    element.dataset.blockId = crypto.randomUUID();
    element.dataset.blockType = 'text';
    element.textContent = options.text || 'Новый текст';
    Object.assign(element.style, {
      position: 'absolute',
      left: '100px',
      top: '140px',
      width: '600px',
      minHeight: '55px',
      margin: '0',
      fontSize: '40px',
      lineHeight: '1.25',
      color: '#f6f8fa',
      padding: '0',
      whiteSpace: 'pre-wrap',
    });
    return element;
  },
});
registerBlockModule({
  id: 'image',
  label: 'Изображение',
  create(doc, options = {}) {
    const element = doc.createElement('img');
    element.dataset.blockId = crypto.randomUUID();
    element.dataset.blockType = 'image';
    element.src = options.src;
    element.alt = options.alt || '';
    Object.assign(element.style, {
      position: 'absolute',
      left: '120px',
      top: '150px',
      width: '420px',
      height: '280px',
      objectFit: 'contain',
      borderRadius: '12px',
    });
    return element;
  },
});
export function blockType(element) {
  if (
    ['preset', 'element', 'text', 'image', 'video', 'group', 'shape', 'icon'].includes(
      element.dataset.blockType,
    )
  )
    return element.dataset.blockType;
  const tag = element.localName.toLowerCase();
  if (tag === 'img') return 'image';
  if (['video', 'audio'].includes(tag)) return 'video';
  if (tag === 'svg') return 'icon';
  if (tag === 'hr') return 'shape';
  if (/^(h[1-6]|p|pre|blockquote|li|span|strong|em|b|i|small|a|label|code)$/.test(tag))
    return 'text';
  return element.childElementCount ? 'group' : element.textContent.trim() ? 'text' : 'shape';
}
export function isSelectableElement(element, root) {
  if (
    !(element instanceof root.ownerDocument.defaultView.Element) ||
    element === root ||
    !root.contains(element)
  )
    return false;
  return (
    !element.closest(
      'script,style,link,meta,template,defs,clipPath,mask,pattern,linearGradient,radialGradient,filter',
    ) && !(element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName !== 'svg')
  );
}
function decorativeSVG(element) {
  if (
    !element?.matches('[data-block-type="element"][data-element-id]') ||
    element.children.length !== 1 ||
    element.firstElementChild.localName !== 'svg'
  )
    return null;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (
    !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor) ||
    style.backgroundImage !== 'none' ||
    style.boxShadow !== 'none' ||
    ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) => parseFloat(style['border' + side + 'Width']) > 0,
    )
  )
    return null;
  return element.firstElementChild;
}
function detachedSVG(element) {
  const svg = decorativeSVG(element);
  if (!svg) return null;
  const owner = element.getBoundingClientRect(),
    art = svg.getBoundingClientRect();
  return ['left', 'top', 'width', 'height'].some((key) => Math.abs(owner[key] - art[key]) > 1)
    ? svg
    : null;
}
export function selectableBlock(target, root, { deep = false } = {}) {
  if (!(target instanceof root.ownerDocument.defaultView.Element) || !root.contains(target))
    return null;
  const svg = target.closest('svg');
  if (svg && isSelectableElement(svg, root)) {
    const owner = svg.closest('[data-block-type="element"][data-element-id]');
    // Обычный клик выбирает рисунок каталога вместе с контейнером. Alt-клик
    // открывает вложенный SVG; отделённые рисунки сохраняют свою геометрию.
    return !deep && isSelectableElement(owner, root) && !detachedSVG(owner) ? owner : svg;
  }
  if (deep && isSelectableElement(target, root)) return target;
  const anchor = target.closest(
    '[data-block-id],[data-block-type],img,video,audio,h1,h2,h3,h4,h5,h6,p,pre,blockquote,li,.card,.node,.pill,.lead,.mono,.section-label',
  );
  const element = isSelectableElement(anchor, root)
    ? anchor
    : isSelectableElement(target, root)
      ? target
      : null;
  return detachedSVG(element) || element;
}
export function selectableBlockAtPoint(target, root, { deep = false, x, y } = {}) {
  if (!selectableBlock(target, root, { deep })) return null;
  const candidates = [target, ...(deep ? [] : root.ownerDocument.elementsFromPoint(x, y))];
  for (const candidate of candidates) {
    const element = selectableBlock(candidate, root, { deep });
    if (!element) continue;
    if (!deep && element.localName === 'svg') {
      const owner = element.parentElement;
      if (detachedSVG(owner) === element && !candidate.closest('svg')) {
        const rect = element.getBoundingClientRect();
        if (x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2)
          continue;
      }
    }
    return element;
  }
  return null;
}
export function cleanSlideHTML(root) {
  const clone = root.cloneNode(true);
  for (const element of clone.querySelectorAll('[contenteditable]'))
    element.removeAttribute('contenteditable');
  for (const element of clone.querySelectorAll('[data-editor-selected]'))
    element.removeAttribute('data-editor-selected');
  return clone.innerHTML;
}
export function colorHex(color, fallback = '#ffffff') {
  const match = String(color).match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
  return match
    ? '#' +
        match
          .slice(1, 4)
          .map((value) => Number(value).toString(16).padStart(2, '0'))
          .join('')
    : /^#[0-9a-f]{6}$/i.test(color)
      ? color
      : fallback;
}
