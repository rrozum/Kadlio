---
name: presentation-runtime
description: Добавить или изменить JS слайда, переиспользуемые эффекты элементов, движение из-за границ холста и собственные видео.
---

HTML остаётся источником. JS хранится в `update_slide.script`, не script tag/event attribute. Он работает в opaque browser scene с slide (rendered section), signal/onCleanup. Нет parent/editor access, storage, сети, server commands и native fs; дополнительные permissions не предоставляют их.

Сначала прочитайте слайд/version. Для element effect используйте `list_effect_snippets`/`read_effect_snippet`, создавайте/обновляйте source только по запросу. Code получает element/slide/params/signal/onCleanup. Верните Animation либо зарегистрируйте отмену через onCleanup. Applied code/options — independent snapshots; каталог не меняет слайды автоматически.

Любой unique unlocked HTML/SVG может получить effect, включая outside block. До `apply_effect_snippet` сохраните уникальный стабильный data-block-id. Обычное appearance сохраняет final position; offcanvas-to-slide намеренно перемещает saved outside position в запрошенную точку. Не меняйте несвязанный текст/исходник.

В JS выбирайте элементы внутри slide по data-block-id. Duplicate сохраняет block IDs, но меняет настоящие HTML/SVG id для независимых definitions. Произвольные string selectors с real IDs не переписываются; адаптируйте их после копирования.

Transitions остаются отдельными timeline entries. Custom transition может иметь `snippet:{snippetId,code,options}` и выполняться на incoming section в обоих направлениях. Сохраняйте слайды/transition IDs и передавайте current project version в `update_timeline`.

Для предоставленного MP4/WebM используйте `use_attachment_video`, затем owned URL в video либо `design.background:{type:'video',value:url,poster?:ownedImageUrl}`. Muted autoplay использует playsinline, audio требует действия. Не выдумывайте video assets и не загружайте remote files.

После JS/effect/layout/video вызывайте `render_slide`, смотрите настоящий image/warnings. atMs — 0–5000 мс после старта, default 800; для motion проверяйте ранний и завершённый кадр. Исправьте script errors, missing targets и unintended clipping до заявления о готовности.

PDF/PPTX использует static saved HTML без JS. Video передаётся кадром/poster; JS effects/custom transitions не становятся PowerPoint animations. Для interactive playback используйте website/HTML и объясняйте ограничение static formats.
