# Видео, JavaScript слайда и переиспользуемые эффекты

HTML/CSS остаётся сохранённым исходником, обычный редактор статичен. Видео и необязательный JS работают в viewer, явном runtime preview и автономном HTML внутри отдельной ограниченной сцены. Они не исполняются в Node или документе редактора.

## Действия автора

**Видео** загружает собственный MP4/WebM до 16 МиБ. **Добавить видео** вставляет перемещаемый блок, **Сделать фоном** меняет общий video background. Есть mute/loop/autoplay. Если браузер декодирует кадр, сохраняется PNG poster. Сигнатура контейнера не гарантирует поддержку codec; autoplay без звука, воспроизведение audio требует действия пользователя.

**JavaScript и эффекты → JS слайда** редактирует программу. **Сохранить JS** использует slide version. **Запустить** сначала сохраняет изменённый script и показывает сохранённую сцену. **Стоп** удаляет сцену и выполняет cleanup; ошибки показываются отдельно. HTML-action меняет body текущего слайда, script не становится HTML-тегом.

Для **Эффект элемента** сначала выберите unlocked HTML/SVG. Выберите библиотечный source либо **Новый эффект**, измените code/JSON params, нажмите **Сохранить в библиотеку** и **Добавить эффект**. Применение хранит собственный snapshot code/options; правка библиотеки не меняет старые применения. Повторное добавление создаёт binding. **Снять эффекты** удаляет bindings выбранного элемента. Preview показывает сохранённые применения, не несохранённый source draft.

Цель — уникальный unlocked элемент, включая off-canvas на 1280×720. Слои выбирают вложенные/outside blocks, parent lock защищает потомков, SVG root — одна цель. `offcanvas-to-slide` намеренно перемещает внешний блок к заданным координатам; обычное появление сохраняет геометрию.

## Контексты и хранение

| Исходник | Хранение | Аргументы |
| --- | --- | --- |
| Программа слайда | `slide.script` | `slide,signal,onCleanup` |
| Библиотечный эффект | `PROJECTS_DATA_DIR/effect-snippets/<id>.json` | `element,slide,params,signal,onCleanup` |
| Применённый эффект | `slide.elementEffects[]` с `{id,blockId,snippetId,code,options}` | Те же arguments, скопированные source/options |
| Custom transition | Timeline `snippet:{snippetId,code,options}` | Входящая section как element и effect context |

Дублирование меняет настоящие HTML id для независимых SVG definitions. Произвольный JS не переписывается; для устойчивости к копированию используйте slide-scoped selectors со стабильным data-block-id.

Code — тело async function, поэтому top-level return допустим:

```js
return element.animate(
  [{opacity: 0}, {opacity: 1}],
  {duration: params.duration || 600, fill: 'forwards'},
);
```

Возврат Animation регистрирует её отмену. Listeners, timers и несколько анимаций освобождаются callback `onCleanup`; signal отменяется при остановке сцены. Стандартные presets учитывают reduced motion, custom JS должен сам реагировать на prefers-reduced-motion.

Переходы остаются отдельными timeline cards. Snapshot не переписывает каталог и запускается для входящей section в обоих направлениях. При изменении сохраняйте timeline и актуальную project version. Перескок через несколько слайдов не создаёт новую границу.

## Инструменты агента и проверка

`update_slide` принимает отдельные script/elementEffects с текущей slide version. `list_effect_snippets`, `read_effect_snippet`, `create_effect_snippet`, `update_effect_snippet`, `apply_effect_snippet` используют те же validated storage operations, что UI. Применение требует уникальный unlocked block ID.

`use_attachment_video` проверяет MP4/WebM и копирует в owned project/theme assets. Returned URL используется в HTML или `design.background:{type:'video',value,poster?}`. Chat attachment ограничен 8 МиБ, dedicated video upload — 16 МиБ.

После layout/code/media изменения вызывайте `render_slide({slideId,atMs})`: native image, block geometry и script/clipping warnings. atMs — 0–5000 мс после старта, default 800; для motion смотрите ранний и завершённый кадр. Это настоящий browser frame, не текстовое описание или static editor. Прочитайте skill presentation-runtime.

Лимиты: 50 000 символов программы, 50 effect bindings на слайд, 8 000 JSON characters params, 200 library sources, 32 МиБ assets на сцену. Server preview — до 25 секунд, при busy/unavailable даёт ошибку. Это не гарантирует низкую стоимость произвольного JS в viewer.

## Изоляция и экспорт

Opaque iframe использует `sandbox="allow-scripts"` без allow-same-origin. Внутри visible HTML и embedded owned media/fonts, без речи, внутренних annotations/account/provider settings. CSP запрещает сеть, forms, nested frames, workers и plugins. Родитель принимает bound-scene status и previous/next navigation; server preview дополнительно блокирует resource requests. Это отдельная граница от MCP-only политики ACP. [Безопасность](../SECURITY.md).

| Формат | Поведение |
| --- | --- |
| Сайт/viewer | Изолированная interactive scene; смена слайда останавливает старую |
| HTML export | Та же scene с embedded media, offline navigation/fullscreen; общий embedded budget 64 МиБ, повтор media увеличивает deck |
| PDF/PPTX | Static HTML без JS. Video даёт кадр/poster, playable video не встраивается. JS/custom transitions пропущены с предупреждением; стандартные transition mappings сохраняются |

HTML export исключает речь, comments/chat/materials/account/keys; authored JS входит в распространяемый видимый исходник. PPTX сохраняет speaker notes в owner export. Codec/fonts и сложный CSS влияют на отображение.

`test/slide-runtime.test.js` проверяет инертное server storage, syntax/CAS, snapshots, owned media, source isolation и scoped tools. `test/slide-runtime-ui.js` — реальные browser scenes. PowerPoint playback/fidelity проверяются отдельно.
