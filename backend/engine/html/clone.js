import { parseHTML } from 'linkedom';
import { randomUUID } from 'node:crypto';

// Новая копия должна иметь независимые DOM/SVG id; локальные url(#...)
// и aria-ссылки переписываются вместе с id, геометрия и содержимое сохраняются.
export function cloneSlideHTML(body) {
  const { document } = parseHTML('<html><body>' + body + '</body></html>'),
    nodes = [...document.body.querySelectorAll('[id]')];
  if (!nodes.length) return body;
  const prefix = 'copy-' + randomUUID(),
    ids = new Map(nodes.map((node, index) => [node.id, prefix + '-' + index]));
  const fragments = (value) =>
    value.replace(
      /url\(\s*(?:(["'])#(.*?)\1|#([^\s)]+))\s*\)/gi,
      (original, quote, quoted, plain) =>
        ids.has(quoted ?? plain)
          ? 'url(' + (quote || '') + '#' + ids.get(quoted ?? plain) + (quote || '') + ')'
          : original,
    );
  for (const node of nodes) node.id = ids.get(node.id);
  for (const node of document.body.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (['id', 'data-block-id'].includes(attribute.name)) continue;
      let value = fragments(attribute.value);
      if (
        ['href', 'xlink:href'].includes(attribute.name) &&
        value.startsWith('#') &&
        ids.has(value.slice(1))
      )
        value = '#' + ids.get(value.slice(1));
      if (['for', 'aria-labelledby', 'aria-describedby', 'aria-controls'].includes(attribute.name))
        value = value
          .split(/\s+/)
          .map((id) => ids.get(id) || id)
          .join(' ');
      if (value !== attribute.value) node.setAttribute(attribute.name, value);
    }
    if (node.localName === 'style')
      node.textContent = fragments(node.textContent).replace(
        /([^{}]+)\{/g,
        (rule, selector) =>
          selector.replace(/#([\w-]+)/g, (token, id) => (ids.has(id) ? '#' + ids.get(id) : token)) +
          '{',
      );
  }
  return document.body.innerHTML;
}
