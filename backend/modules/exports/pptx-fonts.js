import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';

const run = promisify(execFile);

// CDP сообщает фактический шрифт Chromium, включая fallback отсутствующего CSS-шрифта.
export async function resolvePptxFonts(cdp, slideId, model, fonts) {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: `#${slideId} [data-export-font]`,
  });
  const resolved = new Map();
  const platformCache = new Map();
  const platformFonts = async (nodeId) => {
    if (!platformCache.has(nodeId))
      platformCache.set(nodeId, (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts);
    return platformCache.get(nodeId);
  };
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId });
    const key = attributes[attributes.indexOf('data-export-font') + 1];
    const platform = (await platformFonts(nodeId)).map((font) => ({ ...font }));
    // У контейнера CDP считает и вложенный code/span. Для его собственного текста
    // вычитаем дочерние поддеревья, иначе длинный code меняет шрифт соседней подписи.
    const { nodeIds: children } = await cdp.send('DOM.querySelectorAll', {
      nodeId,
      selector: ':scope > *',
    });
    for (const child of children)
      for (const font of await platformFonts(child)) {
        const parentFont = platform.find((entry) => entry.postScriptName === font.postScriptName);
        if (parentFont) parentFont.glyphCount -= font.glyphCount;
      }
    const primary = platform
      .filter((font) => font.glyphCount > 0)
      .sort((a, b) => b.glyphCount - a.glyphCount)[0];
    if (primary) resolved.set(key, primary);
  }
  for (const part of model.lines.flatMap((line) => line.parts)) {
    const platform = resolved.get(part.fontKey);
    if (!platform) continue;
    part.font = platform.familyName;
    const key = `${part.font}:${part.bold}:${part.italic}`;
    if (!fonts.has(key) && fonts.size < 64) {
      fonts.set(key, null);
      // Webfonts WOFF/WOFF2 требуют отдельного конвертера; не подменяем их системным шрифтом.
      if (!platform.isCustomFont) {
        const font = await systemFont(part.font, part.bold, part.italic);
        const bytes = [...fonts.values()].reduce(
          (sum, entry) => sum + (entry?.data.length || 0),
          0,
        );
        if (font && bytes + font.data.length <= 32 * 1024 * 1024) fonts.set(key, font);
      }
    }
  }
}

async function systemFont(family, bold, italic) {
  try {
    const escaped = family.replace(/[\\:,=]/g, '\\$&');
    const { stdout } = await run(
      'fc-match',
      [
        '-f',
        '%{family[0]}\n%{file}\n',
        '--',
        `${escaped}:weight=${bold ? 'bold' : 'regular'}:slant=${italic ? 'italic' : 'roman'}`,
      ],
      { timeout: 3000, maxBuffer: 16384 },
    );
    const [matched, file] = stdout.trim().split('\n');
    if (matched.toLowerCase() !== family.toLowerCase() || !file?.startsWith('/')) return null;
    if ((await stat(file)).size > 8 * 1024 * 1024) return null;
    return { family, ...encodeEot(await readFile(file)) };
  } catch {
    // Отсутствующий fontconfig или неподдерживаемый шрифт не ломает редактируемый экспорт.
    return null;
  }
}

// EOT 0x00020001 без сжатия: https://www.w3.org/submissions/EOT/#FileFormat
export function encodeEot(data) {
  if (data.length < 12 || ![0x00010000, 0x4f54544f].includes(data.readUInt32BE(0)))
    throw new Error('Unsupported OpenType font');
  const count = data.readUInt16BE(4),
    tables = new Map();
  if (count > 512 || 12 + count * 16 > data.length) throw new Error('Invalid font directory');
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16,
      offset = data.readUInt32BE(at + 8),
      length = data.readUInt32BE(at + 12);
    if (offset + length > data.length) throw new Error('Invalid font table');
    tables.set(data.toString('ascii', at, at + 4), data.subarray(offset, offset + length));
  }
  const os2 = tables.get('OS/2'),
    head = tables.get('head'),
    names = tables.get('name');
  if (!os2 || os2.length < 64 || !head || head.length < 12 || !names || names.length < 6)
    throw new Error('Missing font metadata');
  const fsType = os2.readUInt16BE(8),
    level = fsType & 15;
  // Preview/Print делает документ read-only; встраиваем только разрешенные для редактирования.
  if (fsType & 0x200 || (level !== 0 && !(level & 8)))
    throw new Error('Font disallows editable embedding');
  const nameCount = names.readUInt16BE(2),
    strings = names.readUInt16BE(4),
    values = new Map();
  if (nameCount > 4096 || 6 + nameCount * 12 > names.length) throw new Error('Invalid font names');
  for (let i = 0; i < nameCount; i++) {
    const at = 6 + i * 12,
      platform = names.readUInt16BE(at),
      language = names.readUInt16BE(at + 4),
      id = names.readUInt16BE(at + 6),
      length = names.readUInt16BE(at + 8),
      offset = strings + names.readUInt16BE(at + 10);
    if (offset + length > names.length) throw new Error('Invalid font name');
    if (![1, 2, 4, 5].includes(id) || platform !== 3 || language !== 0x409) continue;
    if (length % 2) throw new Error('Invalid UTF-16 font name');
    values.set(id, Buffer.from(names.subarray(offset, offset + length)).swap16());
  }
  if (!values.has(1)) throw new Error('Missing English font family');
  const header = Buffer.alloc(80);
  header.writeUInt32LE(data.length, 4);
  header.writeUInt32LE(0x00020001, 8);
  os2.copy(header, 16, 32, 42);
  header[26] = 1;
  const italic = Boolean(os2.readUInt16BE(62) & 1),
    bold = os2.readUInt16BE(4) >= 600;
  header[27] = Number(italic);
  header.writeUInt32LE(os2.readUInt16BE(4), 28);
  header.writeUInt16LE(fsType, 32);
  header.writeUInt16LE(0x504c, 34);
  for (let i = 0; i < 4; i++) header.writeUInt32LE(os2.readUInt32BE(42 + i * 4), 36 + i * 4);
  if (os2.length >= 86) {
    header.writeUInt32LE(os2.readUInt32BE(78), 52);
    header.writeUInt32LE(os2.readUInt32BE(82), 56);
  }
  header.writeUInt32LE(head.readUInt32BE(8), 60);
  const records = [1, 2, 5, 4].flatMap((id) => {
    const value = values.get(id) || Buffer.alloc(0),
      prefix = Buffer.alloc(4);
    prefix.writeUInt16LE(value.length, 2);
    return [prefix, value];
  });
  const eot = Buffer.concat([header, ...records, Buffer.alloc(4), data]);
  eot.writeUInt32LE(eot.length, 0);
  return { data: eot, bold, italic };
}
