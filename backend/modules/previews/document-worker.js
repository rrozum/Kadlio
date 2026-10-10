// Вход, выход и страницу выбирает родительский процесс. PDF разбирается
// в ограниченном дочернем renderer: повреждённый файл можно остановить по таймауту.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [input, output, pageArgument] = process.argv.slice(2),
  pageNumber = Number(pageArgument);
if (!input || !output || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100)
  process.exit(2);
const pdfRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
let task, document, entry;
try {
  const buffer = await readFile(input);
  if (buffer.length > 32 * 1024 * 1024 || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new Error('invalid_pdf');
  task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    enableXfa: false,
    verbosity: 0,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    cMapUrl: path.join(pdfRoot, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + '/',
    wasmUrl: path.join(pdfRoot, 'wasm') + '/',
  });
  document = await task.promise;
  if (document.numPages > 100) throw new Error('too_many_pages');
  if (pageNumber > document.numPages) throw new Error('page_not_found');
  const page = await document.getPage(pageNumber),
    natural = page.getViewport({ scale: 1 });
  if (
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height) ||
    natural.width < 1 ||
    natural.height < 1
  )
    throw new Error('invalid_dimensions');
  const viewport = page.getViewport({
    scale: Math.min(2, 1200 / Math.max(natural.width, natural.height)),
  });
  const width = Math.max(1, Math.ceil(viewport.width)),
    height = Math.max(1, Math.ceil(viewport.height));
  if (width > 1200 || height > 1200 || width * height > 1_440_000)
    throw new Error('invalid_dimensions');
  entry = document.canvasFactory.create(width, height);
  await page.render({
    canvasContext: entry.context,
    viewport,
    annotationMode: 0,
    background: 'rgb(255,255,255)',
  }).promise;
  let image = entry.canvas.toBuffer('image/png'),
    mimeType = 'image/png';
  if (image.length > 1024 * 1024) {
    image = entry.canvas.toBuffer('image/jpeg', 85);
    mimeType = 'image/jpeg';
  }
  if (image.length > 1024 * 1024) throw new Error('image_too_large');
  await writeFile(output, image, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ width, height, pageCount: document.numPages, mimeType }));
  page.cleanup();
} catch (error) {
  const known = new Set([
    'too_many_pages',
    'page_not_found',
    'image_too_large',
    'invalid_dimensions',
  ]);
  process.stdout.write(
    JSON.stringify({ error: known.has(error.message) ? error.message : 'unreadable_document' }),
  );
  process.exitCode = 1;
} finally {
  if (entry) document?.canvasFactory.destroy(entry);
  await task?.destroy();
}
