import { parseHTML } from 'linkedom';
import { badRequest } from '../errors.js';

// HTML описывает содержимое. JS выполняется только отдельной opaque-сценой.
export function sanitizeHTML(html) {
  if (typeof html !== 'string' || html.length > 500000)
    throw badRequest('HTML слайда слишком большой или имеет неверный формат.');
  const { document } = parseHTML('<html><body>' + html + '</body></html>');
  document
    .querySelectorAll('script,iframe,object,embed,base,meta,link,form,input,textarea,select')
    .forEach((el) => el.remove());
  for (const el of document.querySelectorAll('*'))
    for (const attribute of [...el.attributes]) {
      const name = attribute.name.toLowerCase(),
        value = attribute.value.trim();
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'action'].includes(name))
        el.removeAttribute(attribute.name);
      else if (
        ['src', 'href', 'xlink:href'].includes(name) &&
        !/^(\/[^/]|#|data:image\/(png|jpeg|webp|gif);base64,)/i.test(value)
      )
        el.removeAttribute(attribute.name);
      else if (name === 'style' && /expression\s*\(|javascript\s*:|@import/i.test(value))
        el.removeAttribute(attribute.name);
    }
  return document.body.innerHTML;
}
