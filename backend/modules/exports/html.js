import { readPlayerModule } from './player-bundle.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHTML } from '../../../shared/presentation/html.js';
import { presentationDesignCSS, renderSlideBody } from '../../../shared/presentation/design.js';
import { normalizeTimeline } from '../../../shared/presentation/timeline.js';
import { slideRuntimeDocument, hasSlideRuntime } from '../addons/runtime.js';

// В автономный HTML попадают видимые слайды, без состояния редактора, аккаунта и чата.
export async function exportHTML({ root, project, assetRoot }) {
  const timeline = normalizeTimeline(project),
    byId = new Map(project.slides.map((slide) => [slide.id, slide]));
  project = {
    ...project,
    timeline,
    slides: timeline.filter((entry) => entry.type === 'slide').map((entry) => byId.get(entry.id)),
  };
  const scenes = {};
  let sceneBytes = 0;
  const saveScene = async (slide, transitionId) => {
    const html = await slideRuntimeDocument({
      root,
      project,
      slideId: slide.id,
      readAsset: (name) => readFile(path.join(assetRoot, name)),
      ...(transitionId ? { transitionId } : {}),
    });
    sceneBytes += Math.ceil((Buffer.byteLength(html) * 4) / 3);
    if (sceneBytes > 64 * 1024 * 1024)
      throw new Error(
        'Интерактивные сцены HTML превышают 64 МБ. Уменьшите видео или число видео-слайдов.',
      );
    scenes[slide.id + (transitionId ? ':' + transitionId : '')] =
      Buffer.from(html).toString('base64');
  };
  for (const slide of project.slides)
    if (hasSlideRuntime(slide, project)) {
      await saveScene(slide);
    }
  for (const [index, entry] of timeline.entries())
    if (entry.snippet)
      for (const slideId of [timeline[index - 1].id, timeline[index + 1].id])
        await saveScene(
          project.slides.find((slide) => slide.id === slideId),
          entry.id,
        );
  let css =
    (await readFile(path.join(root, 'frontend/deck.css'), 'utf8')) +
    '\n' +
    (project.css || '') +
    '\n' +
    presentationDesignCSS(project.design);
  let slides = project.slides
    .map(
      (slide, index) =>
        `<section id="${escapeHTML(slide.id)}" class="slide ${project.design ? 'presentation-designed ' : ''}${escapeHTML(slide.layout || '')}${index === 0 ? ' active' : ''}" aria-label="${escapeHTML(slide.title)}" aria-hidden="${index !== 0}">${project.design ? '' : `<div class="section-label">${escapeHTML(slide.section || '')}</div>`}<div class="slide-content">${renderSlideBody(project, slide, index)}</div>${project.design ? '' : `<footer class="footer"><strong>${escapeHTML(project.author || '')}</strong><span class="footer-center">${escapeHTML(project.brand || '')}</span><span class="page-number">${String(index + 1).padStart(2, '0')} / ${project.slides.length}</span></footer>`}</section>`,
    )
    .join('\n');
  const prefix = '/api/projects/' + project.id + '/assets/';
  const references = [
    ...new Set((css + '\n' + slides).match(/\/api\/projects\/[\w-]+\/assets\/[\w.-]+/g) || []),
  ];
  for (const url of references) {
    if (!url.startsWith(prefix) || !assetRoot)
      throw new Error(
        'В презентации есть изображение вне её файлов. Загрузите его в текущий проект перед экспортом HTML.',
      );
    const filename = path.basename(url);
    if (filename.includes('..')) throw new Error('Некорректное изображение.');
    const mime = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
    }[path.extname(filename).toLowerCase()];
    if (!mime) throw new Error('Неизвестный формат изображения.');
    const data =
        'data:' +
        mime +
        ';base64,' +
        (await readFile(path.join(assetRoot, filename))).toString('base64'),
      count = (css + '\n' + slides).split(url).length - 1;
    if (
      sceneBytes + Buffer.byteLength(css) + Buffer.byteLength(slides) + count * data.length >
      64 * 1024 * 1024
    )
      throw new Error(
        'HTML превышает 64 МБ встроенных файлов. Уменьшите видео или число повторений.',
      );
    css = css.split(url).join(data);
    slides = slides.split(url).join(data);
  }
  if (css.includes('/fonts/Geist-Variable.woff2'))
    css = css
      .split('/fonts/Geist-Variable.woff2')
      .join(
        'data:font/woff2;base64,' +
          (await readFile(path.join(root, 'frontend/fonts/Geist-Variable.woff2'))).toString(
            'base64',
          ),
      );
  const effects = await readPlayerModule(root, 'shared/addons/motion/runtime.js');
  const timelineCode = await readPlayerModule(root, 'shared/presentation/timeline.js');
  const metadata = JSON.stringify({
    slides: project.slides.map((slide) => ({ id: slide.id, title: slide.title })),
    timeline,
  }).replace(/</g, '\\u003c');
  const player = await readPlayerModule(root, 'shared/addons/motion/player.js'),
    runtimeData = JSON.stringify(scenes).replace(/</g, '\\u003c');
  return Buffer.from(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline' data:; media-src data: blob:; frame-src 'self' data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHTML(project.title)}</title><style>${css.replace(/<\/style/gi, '<\\/style')}\n.offline-controls{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;z-index:30;padding:8px 12px;border:1px solid #34404e;background:#111820e8;border-radius:12px;color:#eef4fa;font:13px Arial}.offline-controls button{min-width:34px;padding:7px 10px;font-size:13px}.offline-controls span{min-width:65px;text-align:center;font-variant-numeric:tabular-nums}@media print{.offline-controls{display:none!important}}</style></head><body><main class="deck-area"><div class="stage-shell" id="stage-shell"><div class="deck-stage" id="deck-stage">${slides}</div></div></main><nav class="offline-controls" aria-label="Слайды"><button id="previous" aria-label="Предыдущий слайд">←</button><span id="counter" aria-live="polite"></span><button id="next" aria-label="Следующий слайд">→</button><button id="fullscreen" aria-label="Полный экран">⛶</button></nav><script type="application/json" id="offline-data">${metadata}</script><script>${effects}\n${timelineCode}\n${player}\nconst runtimeScenes=${runtimeData};\n(()=>{const project=JSON.parse(document.getElementById('offline-data').textContent),data=project.slides,slides=[...document.querySelectorAll('#deck-stage > .slide')],counter=document.getElementById('counter');let index=Math.max(0,data.findIndex(slide=>'#'+slide.id===location.hash)),touch;function fit(){document.documentElement.style.setProperty('--scale',Math.max(.05,Math.min((innerWidth-32)/1280,(innerHeight-98)/720)));}function go(target){target=Math.max(0,Math.min(slides.length-1,target));const previous=slides[index],direction=target>index?1:-1,effect=boundaryTransition(project,data[index].id,data[target].id);slides.forEach(slide=>{stopSlideEffects(slide);stopRuntime(slide);});index=target;slides.forEach((slide,i)=>{slide.classList.toggle('active',i===index);slide.setAttribute('aria-hidden',String(i!==index));});counter.textContent=(index+1)+' / '+slides.length;document.getElementById('previous').disabled=index===0;document.getElementById('next').disabled=index===slides.length-1;history.replaceState(null,'','#'+data[index].id);const scene=runtimeScenes[data[index].id+(effect?.transitionId?':'+effect.transitionId:'')]||runtimeScenes[data[index].id];if(scene){const html=new TextDecoder().decode(Uint8Array.from(atob(scene),char=>char.charCodeAt(0)));playRuntime(slides[index],{html,sceneId:data[index].id,onNavigate:command=>go(index+(command==='next'?1:-1))});}if(!effect?.snippet)playSlideEffect(slides[index],effect,{previous,direction}).catch(()=>{});}document.getElementById('previous').onclick=()=>go(index-1);document.getElementById('next').onclick=()=>go(index+1);document.getElementById('fullscreen').onclick=()=>{const action=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();action.catch(()=>{});};addEventListener('keydown',event=>{if(['ArrowRight','PageDown',' '].includes(event.key)){event.preventDefault();go(index+1);}else if(['ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();go(index-1);}else if(event.key==='Home')go(0);else if(event.key==='End')go(slides.length-1);});addEventListener('touchstart',event=>touch=event.changedTouches[0].clientX,{passive:true});addEventListener('touchend',event=>{if(touch!==undefined&&Math.abs(event.changedTouches[0].clientX-touch)>50)go(index+(event.changedTouches[0].clientX<touch?1:-1));touch=undefined;},{passive:true});addEventListener('resize',fit);addEventListener('beforeprint',()=>slides.forEach(stopSlideEffects));fit();go(index);})();</script></body></html>`,
  );
}
