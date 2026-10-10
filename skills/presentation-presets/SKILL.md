---
name: presentation-presets
description: Использовать готовые HTML-композиции и темы Kadlio для повторяемых блоков, новой раскладки слайда или общего оформления презентации.
---

# Готовые композиции

Прочитайте проект и затронутый слайд. Через `list_presets` изучите доступные blocks/themes, используйте реальные IDs/fields. Для прямой работы с модулем читайте [контракт каталога](../../docs/presets.md).

Выберите минимальную подходящую композицию: `statement` для мысли, `comparison` для подходов, `metrics` для подтверждённых чисел, `steps`/`timeline` для последовательности, `code-card` для кода, `image-caption` для project asset, `callout`/`checklist` для краткого вывода. Один понятный блок не заменяйте несколькими декоративными.

`insert_preset` использует current slide version и plain text. Заменяйте учебные defaults предоставленными данными. Placeholder numbers, выдуманные цитаты и предполагаемый опыт автора не являются фактами. Картинки принадлежат текущему проекту; remote image URLs/executable content не добавляются.

Сохраняйте `data-block-id`, `data-preset-id` и field identifiers. Wrapper имеет `data-block-type="preset"`; вложенные text/image редактируются отдельно. Мелкая правка может идти через `update_slide`; не перерендеривайте весь preset, если это потеряет ручную геометрию/формат.

`update_design` применяет тему только в запрошенной области; light/dark UI сайта отдельно. Используйте semantic tokens, сохраняйте bodies/notes/annotations и несвязанный layout. Общее изменение темы проверяйте как общее, особенно импорт с собственным CSS. Конфликт требует чтения и слияния.

Значения template меняются `update_variables` с project version. Поддержаны author, brand, projectTitle, slideTitle, section; slide-specific значения требуют slideId/slideVersion. Не переписывайте HTML и не меняйте тему ради metadata. slideNumber/slideCount автоматические; неизвестные placeholders сохраняются.

После сохранения перечитайте project/slide и проверьте browser wrapping, clipping, contrast, position, proportions. При structural change проверьте выбор отдельных fields и движение полной композиции. PDF/PPTX проверяйте для layout-dependent change; HTML/ZIP/XML не подтверждают PowerPoint rendering.
