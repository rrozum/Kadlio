import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { slideDocument } from '../../../shared/presentation/slide-document.js';
import { normalizeTimeline, incomingTransition } from '../../../shared/presentation/timeline.js';

export const runtimeCSP =
  "sandbox allow-scripts; default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const presentationRuntimeInstructions =
  'For requested interactivity, read the presentation-runtime skill. Slide JavaScript is editable source in update_slide.script, executed only in an opaque browser scene with {slide,signal,onCleanup}; never embed script tags in HTML or execute it on the host. Reusable JavaScript effects are available through list/read/create/update_effect_snippet and apply_effect_snippet, and may target any uniquely identified unlocked element, including off-canvas blocks. Existing applications keep independent source snapshots. Use render_slide at an appropriate atMs (0–5000) to inspect the actual animated result and script errors before completion. Supplied MP4/WebM files can be copied with use_attachment_video to owned assets and used as video elements or backgrounds. PDF/PPTX are static and omit user JavaScript/JS effects; interactive playback is available on the website and HTML export. Icons are available through search_icons/insert_icon. To import supplied PPTX as editable HTML use import_pptx with the current version, preserving existing slides unless replacement was explicitly requested.';
import { hasSlideRuntime } from '../../../shared/presentation/runtime.js';
export { hasSlideRuntime } from '../../../shared/presentation/runtime.js';
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const maxDocumentBytes = 64 * 1024 * 1024;

// Сцена получает только видимый HTML и собственные ресурсы. Данные аккаунта,
// заметки, аннотации, API tokens и доступ к браузерному storage ей не передаются.
export async function slideRuntimeDocument({
  root,
  project,
  slideId,
  readAsset,
  assetPrefix = '/api/projects/' + project.id + '/assets/',
  transitionId,
} = {}) {
  const slide = project.slides.find((item) => item.id === slideId);
  if (!slide) throw Object.assign(new Error('Слайд не найден.'), { status: 404 });
  let transition = incomingTransition(project, slideId);
  if (transitionId) {
    const entries = normalizeTimeline(project),
      index = entries.findIndex(
        (entry) => entry.id === transitionId && entry.type === 'transition',
      );
    if (index < 0 || ![entries[index - 1]?.id, entries[index + 1]?.id].includes(slideId))
      throw Object.assign(new Error('Переход не относится к этому слайду.'), { status: 400 });
    transition = entries[index];
  }
  const records = [
    ...(slide.elementEffects || []),
    ...(transition?.snippet
      ? [{ id: transitionId || transition.transitionId, blockId: null, ...transition.snippet }]
      : []),
  ];
  let document = slideDocument(slide, project),
    script = slide.script || '',
    effects = JSON.stringify(records);
  document = document
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace(/<link rel="stylesheet"[^>]*>/, '');
  let css = await readFile(path.join(root, 'frontend/deck.css'), 'utf8');
  const references = [
    ...new Set(
      (document + css + script + effects).match(
        /\/(?:api\/projects\/[\w-]+|s\/[\w-]+)\/assets\/[\w.-]+/g,
      ) || [],
    ),
  ];
  let bytes = 0;
  for (const url of references) {
    const name = path.basename(url),
      mime = types[path.extname(name).toLowerCase()];
    if (!url.startsWith(assetPrefix) || !mime || !readAsset)
      throw Object.assign(new Error('Сцена использует файл вне текущей презентации.'), {
        status: 400,
      });
    const buffer = await readAsset(name);
    bytes += buffer.length;
    if (bytes > 32 * 1024 * 1024)
      throw Object.assign(new Error('Для одного JS-предпросмотра максимум 32 МБ файлов.'), {
        status: 413,
      });
    const embedded = 'data:' + mime + ';base64,' + buffer.toString('base64'),
      strings = [document, css, script, effects],
      count = strings.reduce((sum, value) => sum + value.split(url).length - 1, 0);
    if (
      strings.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + count * embedded.length >
      maxDocumentBytes
    )
      throw Object.assign(
        new Error(
          'Встроенные файлы JS-сцены превышают 64 МБ. Уменьшите видео или число повторений.',
        ),
        { status: 413 },
      );
    document = document.replaceAll(url, embedded);
    css = css.replaceAll(url, embedded);
    script = script.replaceAll(url, embedded);
    effects = effects.replaceAll(url, embedded);
  }
  const fontURL = '/fonts/Geist-Variable.woff2';
  if ((document + css).includes(fontURL)) {
    const font =
      'data:font/woff2;base64,' +
      (await readFile(path.join(root, 'frontend' + fontURL))).toString('base64');
    document = document.replaceAll(fontURL, font);
    css = css.replaceAll(fontURL, font);
  }
  document = document.replace(
    '</head>',
    '<meta http-equiv="Content-Security-Policy" content="' +
      runtimeCSP.replace(/; frame-ancestors[^;]+/, '').replace('sandbox allow-scripts; ', '') +
      '"><style>' +
      css.replace(/<\/style/gi, '<\\/style') +
      '</style></head>',
  );
  const sceneId = JSON.stringify(slide.id),
    embeddedRecords = JSON.parse(effects),
    bindings = embeddedRecords.map((item) => ({
      id: item.id,
      blockId: item.blockId,
      options: item.options || {},
    }));
  const program =
    runtimeBootstrap(sceneId, JSON.stringify(bindings)) +
    `\nconst slideProgram=async function({slide,signal,onCleanup}){\n${script}\n};\nconst elementPrograms=[${embeddedRecords.map((item) => `async function({element,slide,params,signal,onCleanup}){\n${item.code}\n}`).join(',')}];\nstartRuntime(slideProgram,elementPrograms);\n})();`;
  const encoded = Buffer.from(program).toString('base64');
  if (Buffer.byteLength(document) + encoded.length > maxDocumentBytes)
    throw Object.assign(new Error('JS-сцена превышает 64 МБ.'), { status: 413 });
  return document.replace(
    '</body>',
    '<script src="data:text/javascript;base64,' + encoded + '"></script></body>',
  );
}

function runtimeBootstrap(sceneId, bindings) {
  return `(()=>{'use strict';
const sceneId=${sceneId},bindings=${bindings},slide=document.querySelector('.slide'),controller=new AbortController(),cleanups=[];
const runtime=window.__presentationRuntime={ready:false,started:false,errors:[],sceneId};
for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])try{Object.defineProperty(window,name,{value:undefined,writable:false,configurable:false});}catch{}
function report(){parent.postMessage({type:'presentation-runtime',sceneId,ready:runtime.ready,errors:runtime.errors.slice(0,10)},'*');}
function error(value){runtime.errors.push(String(value?.message||value).slice(0,1000));runtime.errors=runtime.errors.slice(-10);report();}
function onCleanup(callback){if(typeof callback==='function')cleanups.push(callback);else if(callback?.cancel)cleanups.push(()=>callback.cancel());}
function stop(){controller.abort();for(const cleanup of cleanups.splice(0))try{cleanup();}catch{}for(const video of document.querySelectorAll('video'))video.pause();}
addEventListener('error',event=>error(event.error||event.message));addEventListener('unhandledrejection',event=>{event.preventDefault();error(event.reason);});addEventListener('pagehide',stop);
addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='presentation-runtime-control'&&event.data.sceneId===sceneId&&event.data.command==='stop')stop();});
addEventListener('keydown',event=>{if(['INPUT','TEXTAREA'].includes(event.target.tagName)||event.target.isContentEditable)return;let command;if(['ArrowRight','PageDown',' '].includes(event.key))command='next';if(['ArrowLeft','PageUp'].includes(event.key))command='previous';if(command){event.preventDefault();parent.postMessage({type:'presentation-runtime-navigation',sceneId,command},'*');}});
async function startRuntime(program,effects){await document.fonts.ready;runtime.ready=true;runtime.started=true;runtime.startedAt=performance.now();report();const context={slide,signal:controller.signal,onCleanup};
Promise.resolve().then(()=>program(context)).then(onCleanup,error);
for(const [index,binding]of bindings.entries()){const found=binding.blockId===null?[slide]:[...slide.querySelectorAll('[data-block-id]')].filter(node=>node.dataset.blockId===binding.blockId);if(found.length!==1){error('Блок эффекта не найден или его ID повторяется: '+binding.blockId);continue;}Promise.resolve().then(()=>effects[index]({...context,element:found[0],params:binding.options})).then(onCleanup,error);}
for(const video of document.querySelectorAll('video[autoplay]')){video.muted=true;video.playsInline=true;video.play().catch(()=>{});}
}
`;
}
