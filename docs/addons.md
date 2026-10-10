# Дополнения: каталог, UI и runtime

Addon — область поведения поверх общего объекта презентации. Сейчас это композиции, дизайнерские элементы, SVG-иконки и анимации. Дополнение может касаться одного элемента, слайда, timeline или проекта, но не создаёт альтернативное хранилище презентации.

## Части дополнения

| Часть | Расположение | Ответственность |
| --- | --- | --- |
| Описание/каталог | `shared/addons/` | ID, targets, capabilities, данные для Node и браузера |
| Серверный адаптер | `backend/modules/addons/` | Валидация, каталог, применение через движок |
| Панель | `frontend/addons/` | Выбор, поиск, предпросмотр, callbacks редактора |
| Исполнение презентации | `shared/addons/motion/` и runtime-модуль | Изолированный JS, если дополнению он нужен |
| Сохранение | Движок и его репозитории | HTML, метаданные, версии и снимки применённых экземпляров |

Не каждому addon нужны все пять частей. Иконке достаточно каталога, рендера SVG и UI; сложный интерактивный объект дополнительно потребует runtime и честных ограничений экспорта.

Существующие серверные команды разнесены по `backend/modules/addons/compositions.js`, `design-elements.js` и `motion.js`; `service.js` остаётся небольшой явной проводкой этих операций. Каталоги элементов, снимков эффектов и иконок хранятся/проверяются отдельными адаптерами в том же модуле.

## Реестры

`shared/addons/registry.js` создаёт read-only описание возможностей. `shared/addons/builtins.js` содержит четыре текущих ID: `compositions`, `design-elements`, `icons`, `motion`.

`frontend/addons/registry.js` связывает эти описания с `mount`. `mountEditorAddons(context, options, mounts)` подключает только те записи, для которых в `options` явно задан собственный ключ ID, и возвращает экземпляры по ID. Тот же реестр используется редактором темы с нужным подмножеством UI.

Контекст включает `base`, `getCanvas()`, `getProject()`, `getSlide()`, `flush()`, `onError(error)`, `onSelectTab(name)`. `options[id]` добавляет конкретные slots и callbacks, такие как `onSlide`/`onProject`. Он не отдаёт дополнению SQLite или fs.

## Пример кнопки, вставляющей HTML

```js
// frontend/addons/callout/ui.js
export function mountCallout({button, getCanvas, flush, onError}) {
  const insert = async () => {
    const canvas = getCanvas();
    if (!canvas) return;
    const element = document.createElement('p');
    element.dataset.blockId = crypto.randomUUID();
    element.dataset.blockType = 'text';
    element.textContent = 'Важная мысль';
    Object.assign(element.style, {
      position: 'absolute', left: '100px', top: '160px', width: '600px',
      padding: '24px', border: '2px solid #199af0', borderRadius: '16px',
    });
    try {
      canvas.insert(element); // Существующий callback изменённого холста.
      await flush();          // Обычное сохранение и проверка версии.
    } catch (error) {
      onError(error);
    }
  };
  button.addEventListener('click', insert);
  return {destroy() { button.removeEventListener('click', insert); }};
}
```

В точке сборки редактора:

```js
import {editorAddonMounts, mountEditorAddons} from './addons/registry.js';
import {mountCallout} from './addons/callout/ui.js';

const mounts = [...editorAddonMounts, {
  id: 'callout',
  title: 'Выноска',
  targets: ['slide'],
  capabilities: ['insert'],
  mount: mountCallout,
}];

const addons = mountEditorAddons(context, {
  ...existingOptions,
  callout: {button: document.querySelector('#insert-callout')},
}, mounts);
```

`context`, `existingOptions` и кнопка принадлежат существующей сборке UI; их нужно явно добавить туда. Это пример расширения, а не код, автоматически подключённый к приложению.

## Серверное применение и агент

Если addon вставляет ресурс/снимок через сервер, сначала выполните `flush()`, затем получите актуальную версию слайда/проекта и вызовите общий API. После ответа используйте существующий callback обновления UI. Не записывайте файлы напрямую и не обходите очередь движка.

Инструмент агента определяется в `backend/modules/mcp/` и вызывает ту же серверную операцию. Привязка инструмента к проекту/теме, ограничения HTML и CAS обязательны. Навык в `skills/` объясняет агенту, когда использовать новый каталог и как проверить результат через render.

## Снимки, анимации и экспорт

Вставленный HTML и применённые эффекты — независимые экземпляры. Правка каталога не переписывает уже созданные презентации.

Код runtime хранится отдельно от HTML-атрибутов и выполняется только в sandbox scene. Анимированные координаты и preview-узлы не должны попадать в сохранённый исходник. Переход — запись между slide references в timeline; каждый слайд встречается ровно один раз.

Дополнение обязано определить поведение PDF/PPTX/HTML. Сейчас PDF/PPTX не запускают JS; нестатичная возможность должна давать существующий warning/статичное представление, а не обещание полной поддержки PowerPoint. [Runtime](presentation-runtime.md), [темы и эффекты](themes-and-effects.md).
