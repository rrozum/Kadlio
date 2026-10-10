import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHTML } from '../../../shared/presentation/html.js';
import { presentationDesignCSS, renderSlideBody } from '../../../shared/presentation/design.js';
import { normalizeTimeline } from '../../../shared/presentation/timeline.js';
import { hasSlideRuntime } from '../../../shared/presentation/runtime.js';

export async function renderProject(root, project) {
  const timeline = normalizeTimeline(project),
    byId = new Map(project.slides.map((slide) => [slide.id, slide]));
  project = {
    ...project,
    timeline,
    slides: timeline.filter((entry) => entry.type === 'slide').map((entry) => byId.get(entry.id)),
  };
  const shell = await readFile(path.join(root, 'frontend/shell.html'), 'utf8');
  const slides = project.slides
    .map((s, i) => {
      const tag =
        s.kind === 'backup' ? 'Резерв' : s.kind === 'questions' ? 'Вопросы / 5–10 мин' : '';
      return `<section id="${s.id}" class="slide ${project.design ? 'presentation-designed' : ''} ${escapeHTML(s.layout || '')} ${i === 0 ? 'active' : ''}" aria-label="${escapeHTML(s.title)}" aria-hidden="${i !== 0}">${project.design ? '' : `<div class="section-label">${escapeHTML(s.section || '')}${tag ? `<span class="sep">/</span>${tag}` : ''}</div>`}<div class="slide-content">${renderSlideBody(project, s, i)}</div>${project.design ? '' : `<footer class="footer"><strong>${escapeHTML(project.author || '')}</strong><span class="footer-center">${escapeHTML(project.brand || '')}</span><span class="page-number">${String(i + 1).padStart(2, '0')} / ${project.slides.length}</span></footer>`}</section>`;
    })
    .join('\n');
  const data = {
    annotations: project.annotations,
    title: project.title,
    timeline,
    runtimeSlides: project.slides
      .filter((slide) => hasSlideRuntime(slide, project))
      .map((slide) => slide.id),
    apiBase: project.apiBase || '',
    readOnly: !!project.readOnly,
    ...(project.publicShare ? { publicShare: project.publicShare } : {}),
  };
  return shell
    .replace('__SLIDES__', slides)
    .replace('__DATA__', JSON.stringify(project.slides).replace(/</g, '\\u003c'))
    .replace('__PROJECT__', JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace(
      '__ACCOUNT__',
      project.username
        ? '<button id="logout" type="button" title="Выйти из аккаунта" aria-label="Выйти">↪</button>'
        : '',
    )
    .replace('__TITLE__', escapeHTML(project.title))
    .replace(
      '__THEME__',
      `<style>${(project.css || '').replace(/<\/style/gi, '')}${presentationDesignCSS(project.design)}</style>`,
    )
    .replace('__VIEW_CLASS__', project.readOnly ? 'readonly' : '');
}
