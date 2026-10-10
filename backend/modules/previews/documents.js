import path from 'node:path';
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  access,
  mkdtemp,
  rm,
  rename,
  readdir,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';

export const documentPreviewLimits = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  pdfBytes: 32 * 1024 * 1024,
  imageBytes: 1024 * 1024,
  pages: 100,
  side: 1200,
  zipBytes: 50 * 1024 * 1024,
  zipEntries: 4096,
  convertMs: 45_000,
  renderMs: 20_000,
  cacheBytes: 160 * 1024 * 1024,
  cacheEntries: 64,
});
export const documentReferenceInstructions =
  "When the user supplies a presentation or PDF as a style reference, inspect actual page images through render_document_page, not extracted text alone. For PPTX, also use inspect_presentation_reference to read palette, fonts, master/layout inheritance, shapes and image asset IDs. Generic Office masters may not describe the actual slide style; compare representative pages. Use use_reference_image to copy selected source raster assets into the current theme or presentation. Preserve the user's requested title/content and literal template variables; do not substitute sample/demo slide wording for the new content. Compare the result with render_theme or render_slide and correct the visible mismatch. If visual conversion is unavailable, say so explicitly; never claim to have reproduced a style you could not see.";
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const worker = fileURLToPath(new URL('./document-worker.js', import.meta.url));
const formats = { '.pdf': 'pdf', '.pptx': 'pptx', '.odp': 'odp' };
const warnings = {
  converted:
    'Preview rendered with LibreOffice; PowerPoint fonts, SmartArt, charts or unsupported effects may differ.',
  external:
    'External document resources were blocked; those resources are absent from this preview.',
};

export function documentFormat(metadata) {
  return formats[path.extname(metadata?.name || '').toLowerCase()] || null;
}
export function documentVisualHint(metadata) {
  const format = documentFormat(metadata);
  return format
    ? {
        format,
        visualTool: 'render_document_page',
        firstPage: 'supplied when rendering is available',
        pageNumbering: 'one-based',
      }
    : undefined;
}

// Кэш содержит только приватные производные файлы. Оригинал предварительно
// читается через AttachmentStore/MaterialsStore с проверкой принадлежности контексту.
export class DocumentPreviewStore {
  constructor({
    dataDir,
    command = process.env.LIBREOFFICE_COMMAND || '/usr/bin/libreoffice',
    sandboxCommand = process.env.DOCUMENT_SANDBOX_COMMAND || '/usr/bin/bwrap',
    convertMs = documentPreviewLimits.convertMs,
    renderMs = documentPreviewLimits.renderMs,
  } = {}) {
    if (!dataDir) throw new Error('Document preview dataDir is required.');
    if (!path.isAbsolute(command) || !path.isAbsolute(sandboxCommand))
      throw new Error('Document converter commands must be configured absolute paths.');
    this.directory = path.join(dataDir, 'ai', 'document-previews');
    this.command = command;
    this.sandboxCommand = sandboxCommand;
    this.convertMs = Math.min(documentPreviewLimits.convertMs, Math.max(100, convertMs));
    this.renderMs = Math.min(documentPreviewLimits.renderMs, Math.max(100, renderMs));
    this.active = null;
    this.closed = false;
  }
  async render({ metadata, buffer }, page = 1, { signal } = {}) {
    signal?.throwIfAborted();
    if (!Number.isInteger(page) || page < 1 || page > documentPreviewLimits.pages)
      throw failure('Укажите страницу от 1 до 100.');
    if (
      !Buffer.isBuffer(buffer) ||
      !buffer.length ||
      buffer.length > documentPreviewLimits.inputBytes
    )
      throw failure('Неверный размер оригинала документа.');
    const format = documentFormat(metadata);
    if (!format)
      return {
        document: {
          status: 'unsupported_format',
          warnings: ['Visual previews are supported for PDF, PPTX and ODP only.'],
        },
      };
    const key = createHash('sha256')
        .update('document-preview-v1\0' + format + '\0')
        .update(buffer)
        .digest('hex'),
      directory = path.join(this.directory, key);
    const cached = await this.cached(directory, page);
    if (cached) return cached;
    if (this.closed) throw failure('Просмотр документов остановлен.', 503);
    if (this.active)
      throw failure('Предпросмотр другого документа ещё выполняется. Повторите запрос.', 429);
    const controller = new AbortController(),
      combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.active = controller;
    let temporary;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(path.join(this.directory, '.job-'));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let pdfFile = path.join(directory, 'document.pdf'),
        document;
      try {
        document = JSON.parse(await readFile(path.join(directory, 'document.json'), 'utf8'));
        await boundedRead(pdfFile, documentPreviewLimits.pdfBytes);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        document = null;
      }
      if (!document) {
        document = {
          status: 'ready',
          format,
          renderer: format === 'pdf' ? 'pdfjs' : 'libreoffice+pdfjs',
          warnings: format === 'pdf' ? [] : [warnings.converted],
        };
        let pdf = buffer;
        if (format !== 'pdf') {
          try {
            await access(this.command, constants.X_OK);
            await access(this.sandboxCommand, constants.X_OK);
          } catch {
            return {
              document: {
                ...document,
                status: 'converter_unavailable',
                warnings: [
                  ...document.warnings,
                  'The server document converter or its isolated sandbox is unavailable.',
                ],
              },
            };
          }
          const prepared = await prepareOfficeDocument(buffer, format);
          if (prepared.externalBlocked) document.warnings.push(warnings.external);
          const source = path.join(temporary, 'source.' + format),
            profile = path.join(temporary, 'profile', 'user');
          await mkdir(profile, { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(profile, 'registrymodifications.xcu'),
            '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>',
            { mode: 0o600 },
          );
          await writeFile(source, prepared.buffer, { mode: 0o600 });
          const args = await this.sandboxArguments(temporary, format);
          await run(this.sandboxCommand, args, {
            signal: combined,
            timeout: this.convertMs,
            seccomp: documentNetworkFilter(),
            env: {
              PATH: '/usr/bin:/bin',
              LANG: 'C.UTF-8',
              HOME: '/work/profile',
              TMPDIR: '/tmp',
              SAL_USE_VCLPLUGIN: 'svp',
            },
          });
          pdf = await boundedRead(
            path.join(temporary, 'source.pdf'),
            documentPreviewLimits.pdfBytes,
          );
        }
        if (!pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')))
          throw failure('unreadable_document');
        await atomicFile(pdfFile, pdf);
      }
      combined.throwIfAborted();
      const output = path.join(temporary, 'page'),
        stdout = await run(
          process.execPath,
          ['--max-old-space-size=256', worker, pdfFile, output, String(page)],
          { signal: combined, timeout: this.renderMs },
        );
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw failure('unreadable_document');
      }
      if (result.error) throw failure(result.error);
      if (
        !Number.isInteger(result.pageCount) ||
        result.pageCount < page ||
        result.pageCount > 100 ||
        !['image/png', 'image/jpeg'].includes(result.mimeType) ||
        !Number.isInteger(result.width) ||
        !Number.isInteger(result.height) ||
        result.width < 1 ||
        result.height < 1 ||
        result.width > 1200 ||
        result.height > 1200
      )
        throw failure('unreadable_document');
      const image = await boundedRead(output, documentPreviewLimits.imageBytes),
        metadataResult = {
          document: { ...document, pageCount: result.pageCount },
          page,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
        };
      await atomicFile(path.join(directory, 'page-' + page + '.bin'), image);
      await atomicFile(
        path.join(directory, 'page-' + page + '.json'),
        JSON.stringify(metadataResult),
      );
      await atomicFile(
        path.join(directory, 'document.json'),
        JSON.stringify(metadataResult.document),
      );
      await this.prune(key);
      return {
        ...metadataResult,
        preview: { mimeType: result.mimeType, data: image.toString('base64') },
      };
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      const statuses = new Set([
        'unsafe_document',
        'too_many_pages',
        'page_not_found',
        'image_too_large',
        'preview_timeout',
      ]);
      let code = statuses.has(error.message) ? error.message : 'unreadable_document';
      if (format !== 'pdf' && error.message === 'process_failed') code = 'conversion_failed';
      return {
        document: {
          status: code,
          format,
          renderer: format === 'pdf' ? 'pdfjs' : 'libreoffice+pdfjs',
          warnings: [
            code === 'conversion_failed'
              ? 'The isolated document converter could not render this document.'
              : code === 'preview_timeout'
                ? 'Document rendering exceeded its time limit.'
                : 'No visual preview was produced; extracted text alone does not describe the document style.',
          ],
        },
        page,
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      // Ошибка или отсутствие конвертера не должны оставлять растущий кэш неудачных задач.
      try {
        await access(path.join(directory, 'document.json'));
      } catch {
        await rm(directory, { recursive: true, force: true });
      }
      if (this.active === controller) this.active = null;
    }
  }
  async cached(directory, page) {
    try {
      const result = JSON.parse(
          await readFile(path.join(directory, 'page-' + page + '.json'), 'utf8'),
        ),
        image = await boundedRead(
          path.join(directory, 'page-' + page + '.bin'),
          documentPreviewLimits.imageBytes,
        );
      if (
        result.document?.status !== 'ready' ||
        !['image/png', 'image/jpeg'].includes(result.mimeType)
      )
        return null;
      return { ...result, preview: { mimeType: result.mimeType, data: image.toString('base64') } };
    } catch {
      return null;
    }
  }
  async sandboxArguments(directory, format) {
    // Некоторые ядра VPS запрещают запуск loopback в отдельном namespace.
    // Сетевой namespace оставляем общим, но seccomp разрешает только AF_UNIX sockets.
    const args = [
      '--unshare-all',
      '--share-net',
      '--seccomp',
      '3',
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/usr',
      '/usr',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      directory,
      '/work',
    ];
    for (const entry of [
      '/lib',
      '/lib64',
      '/bin',
      '/etc/fonts',
      '/etc/alternatives',
      '/etc/libreoffice',
      '/etc/ld.so.cache',
    ])
      try {
        await access(entry);
        args.push('--ro-bind', entry, entry);
      } catch {}
    // Видны только системные runtime/fonts и приватный каталог этой задачи.
    args.push(
      '--chdir',
      '/work',
      '--',
      this.command,
      '-env:UserInstallation=file:///work/profile',
      '--headless',
      '--nologo',
      '--nodefault',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      'pdf:impress_pdf_Export',
      '--outdir',
      '/work',
      '/work/source.' + format,
    );
    return args;
  }
  async prune(currentKey) {
    const entries = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true }))
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
        const directory = path.join(this.directory, entry.name);
        let bytes = 0;
        for (const file of await readdir(directory))
          bytes += (await stat(path.join(directory, file))).size;
        entries.push({
          key: entry.name,
          directory,
          bytes,
          modified: (await stat(path.join(directory, 'document.json')).catch(() => stat(directory)))
            .mtimeMs,
        });
      }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0),
      count = entries.length;
    for (const entry of entries
      .filter((entry) => entry.key !== currentKey)
      .sort((a, b) => a.modified - b.modified)) {
      if (total <= documentPreviewLimits.cacheBytes && count <= documentPreviewLimits.cacheEntries)
        break;
      await rm(entry.directory, { recursive: true, force: true });
      total -= entry.bytes;
      count--;
    }
  }
  close() {
    this.closed = true;
    this.active?.abort();
  }
}

async function boundedRead(file, maximum) {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > maximum) throw failure('unreadable_document');
  return readFile(file);
}
async function atomicFile(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
function run(command, args, { signal, timeout, env, seccomp } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let ended = false,
      stdout = '',
      size = 0;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe', ...(seccomp ? ['pipe'] : [])],
      detached: process.platform !== 'win32',
      env: env || { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    });
    if (seccomp) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(seccomp);
    }
    const terminate = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        terminate();
        reject(error);
      } else resolve(stdout);
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(failure('preview_timeout')), timeout);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) finish(failure('process_failed'));
      else stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(failure('process_failed')));
    child.on('close', (code) => {
      if (code === 0) finish();
      else {
        try {
          const result = JSON.parse(stdout);
          finish(failure(result.error || 'process_failed'));
        } catch {
          finish(failure('process_failed'));
        }
      }
    });
  });
}

async function zipText(entry) {
  if (entry?._data?.uncompressedSize > 2 * 1024 * 1024) throw failure('unsafe_document');
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [],
      stream = entry.internalStream('nodebuffer');
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        stream.pause();
        reject(failure('unsafe_document'));
      } else chunks.push(chunk);
    });
    stream
      .on('error', () => reject(failure('unsafe_document')))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .resume();
  });
}
// Перед конвертацией документ пересобирается: макросы и вложенные программы
// отклоняются, ссылки на сеть и файлы хоста удаляются. OS sandbox также закрывает
// сеть, данные приложения, credentials и домашние каталоги.
export async function prepareOfficeDocument(buffer, format) {
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw failure('unsafe_document');
  }
  const names = Object.keys(archive.files);
  if (
    names.length > documentPreviewLimits.zipEntries ||
    names.some((name) => {
      const original = archive.files[name].unsafeOriginalName || name;
      return (
        original.startsWith('/') ||
        original.includes('\\') ||
        original.split('/').includes('..') ||
        /[\x00-\x1f]/.test(original) ||
        (/vbaProject|(?:^|\/)Scripts\/|(?:^|\/)Basic\/|\.exe$|\.dll$|\.bin$/i.test(name) &&
          !/^ppt\/printerSettings\//.test(name))
      );
    })
  )
    throw failure('unsafe_document');
  const expanded = names.reduce(
    (sum, name) => sum + (archive.files[name]._data?.uncompressedSize || 0),
    0,
  );
  if (expanded > documentPreviewLimits.zipBytes) throw failure('unsafe_document');
  let actualExpanded = 0;
  for (const entry of Object.values(archive.files).filter((entry) => !entry.dir))
    await new Promise((resolve, reject) => {
      let ended = false;
      const stream = entry.internalStream('nodebuffer');
      const stop = () => {
        if (ended) return;
        ended = true;
        stream.pause();
        reject(failure('unsafe_document'));
      };
      stream
        .on('data', (chunk) => {
          actualExpanded += chunk.length;
          if (actualExpanded > documentPreviewLimits.zipBytes) stop();
        })
        .on('error', stop)
        .on('end', () => {
          if (!ended) {
            ended = true;
            resolve();
          }
        })
        .resume();
    });
  if (
    (format === 'pptx' && !archive.file('ppt/presentation.xml')) ||
    (format === 'odp' && !archive.file('content.xml'))
  )
    throw failure('unsafe_document');
  let externalBlocked = false;
  for (const name of names.filter((name) =>
    format === 'pptx'
      ? name.endsWith('.rels')
      : ['content.xml', 'styles.xml', 'META-INF/manifest.xml'].includes(name),
  )) {
    const xml = await zipText(archive.file(name));
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw failure('unsafe_document');
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    let changed = false;
    if (format === 'pptx')
      for (const relation of [...document.querySelectorAll('*')].filter(
        (element) => element.localName?.split(':').at(-1) === 'Relationship',
      )) {
        let target = relation.getAttribute('Target') || '';
        try {
          target = decodeURIComponent(target);
        } catch {
          target = '../invalid';
        }
        const packagePath = path.posix.normalize(
          path.posix.join(path.posix.dirname(path.posix.dirname(name)), target),
        );
        if (
          relation.getAttribute('TargetMode') === 'External' ||
          /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(target) ||
          packagePath === '..' ||
          packagePath.startsWith('../')
        ) {
          relation.remove();
          changed = externalBlocked = true;
        }
      }
    else
      for (const element of [...document.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes].filter(
          (attribute) => attribute.name.split(':').at(-1) === 'href',
        )) {
          let target = attribute.value;
          try {
            target = decodeURIComponent(target);
          } catch {
            target = '../invalid';
          }
          if (target && /^(?:[a-z][a-z0-9+.-]*:|\/|\\)|(?:^|\/)\.\.(?:\/|$)/i.test(target)) {
            element.removeAttribute(attribute.name);
            changed = externalBlocked = true;
          }
        }
      }
    if (changed) archive.file(name, document.toString());
  }
  return {
    buffer: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    externalBlocked,
  };
}

// Linux classic BPF над struct seccomp_data: фиксированные правила оператора,
// без пользовательского ввода. Подпроцессы не открывают IP/netlink sockets и
// не обходят фильтрацию через io_uring. Унаследованы только файловые дескрипторы и pipes.
export function documentNetworkFilter(arch = process.arch) {
  const platform = {
    x64: { audit: 0xc000003e, socket: 41, pair: 53 },
    arm64: { audit: 0xc00000b7, socket: 198, pair: 199 },
  }[arch];
  if (!platform) throw failure('conversion_failed');
  const LD = 0x20,
    EQ = 0x15,
    SET = 0x45,
    RET = 0x06,
    deny = 0x0005000d,
    allow = 0x7fff0000;
  const instructions = [
    [LD, 0, 0, 4],
    [EQ, 1, 0, platform.audit],
    [RET, 0, 0, 0x80000000],
    [LD, 0, 0, 0],
    [SET, 0, 1, 0x40000000],
    [RET, 0, 0, deny],
    [EQ, 0, 1, 425],
    [RET, 0, 0, deny],
    [EQ, 1, 0, platform.socket],
    [EQ, 0, 3, platform.pair],
    [LD, 0, 0, 16],
    [EQ, 1, 0, 1],
    [RET, 0, 0, deny],
    [RET, 0, 0, allow],
  ];
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    filter.writeUInt16LE(code, offset);
    filter[offset + 2] = jt;
    filter[offset + 3] = jf;
    filter.writeUInt32LE(k >>> 0, offset + 4);
  });
  return filter;
}
