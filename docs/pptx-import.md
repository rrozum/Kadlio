# Импорт PPTX в редактируемый HTML

В галерее **Import PPTX** принимает .pptx, необязательный заголовок и выбор скрытых слайдов. Импортер создаёт новую презентацию и показывает предупреждения перед редактором. ИИ и LibreOffice не вызываются; оригинал сохраняется в приватных материалах.

HTML остаётся источником. Текст не рисуется в картинке всего слайда, поэтому изменение заголовка удаляет старую формулировку. Картинки копируются в собственные assets. Прямоугольники, скругления и эллипсы — редактируемый CSS; остальные поддерживаемые контуры — SVG. Редактор, заметки, ссылки и экспорт работают с импортированным проектом.

## Сохраняемые возможности

| Исходник | Представление |
| --- | --- |
| Порядок и заголовки | Стабильные slide IDs, timeline и исходные номера в metadata |
| Речь | Редактируемые заметки отдельно от видимого текста |
| Master/layout цвета, шрифты, фон и placeholder geometry | Вычисленные styles и отдельные копии у каждого слайда |
| Общая decoration master/layout | Locked blocks с `data-pptx-layer`; замок снимается явно |
| Text runs | Шрифт/размер/цвет, bold, italic, underline, strike, character spacing |
| Явные paragraph styles | Alignment, line/paragraph spacing и базовые bullets; сложная нумерация может отличаться |
| Text boxes | Положение/размер, отступы текста и вертикальное выравнивание |
| Простые shapes/lines | CSS/SVG с поддерживаемыми числовыми custom paths |
| PNG/JPEG/WebP/GIF | Собственные assets, положение/размер, crop, flip и rotation |
| Вложенные группы | Отдельные блоки с составленными affine transforms; иерархия групп уплощается |
| Другой aspect ratio | Равномерное масштабирование с полями на 1280×720 |

Наследование становится редактируемым snapshot, а не живой ссылкой на библиотечную тему. Правка объекта одного слайда не меняет другие. Sample placeholder text master/layout не дублируется поверх реального текста.

## Лимиты и различия

Поддерживается .pptx, не бинарный .ppt, encrypted или macro-enabled. Лимиты: 8 МиБ compressed, 40 МиБ фактически распакованных данных, 2 048 entries, 2 МиБ на XML part, 100 source slides, 5 000 shapes, 256 raster images, 25 миллионов pixels на изображение и миллион text characters. HTML слайда — до 200 000 символов. Превышение даёт явную ошибку, а не silent truncation. Hidden slides по умолчанию исключены; включённые становятся обычными видимыми слайдами.

Charts/tables/SmartArt становятся подписанными редактируемыми placeholders. SVG/EMF/WMF images, embedded fonts, audio/video, OLE, анимации и PowerPoint transitions не импортируются. Неподдерживаемые preset shapes/custom-path formulas приближаются простой фигурой с предупреждением. Градиенты внутри непрямоугольных shapes, brightness modifiers, shadows, vertical text, autofit, advanced numbering и proprietary effects могут отличаться. Шрифты/переносы браузера и дальнейший PDF/PPTX тоже могут отличаться от PowerPoint. Отчёт не гарантирует pixel fidelity.

Для визуальной проверки агент читает оригинал через `read_material`, получает страницы `render_document_page` и сравнивает с `render_slide`. Отдельный LibreOffice/PDF.js pipeline даёт reference image, а не фон импортируемого слайда. [Оформление по образцу](reference-import.md).

## API и агент

`POST /api/projects/import-pptx` принимает `{name,data,title?,includeHidden?}`, data — base64, mime необязателен. Нужны авторизация и корректный Origin. Ответ — snapshot с importReport, warnings и material ID приватного оригинала.

`Library.importPptxInto(projectId,{buffer,name,version,mode,includeHidden?})` импортирует в существующий проект. Источник attachment/material обязан принадлежать ему. Default append сохраняет slides, transitions, annotations, notes и theme settings. Replace явно требует актуальной версии, создаёт новые slide IDs, сохраняет старые HTML/assets и архив прежних slide/timeline/annotation metadata в private imports/. Это архив, а не автоматический Undo UI.

Project-bound `import_pptx` принимает ровно один attachmentId/materialId текущего проекта, version, optional mode append/replace и includeHidden. Нет произвольного filepath или источника другого проекта; в theme-only session инструмент недоступен.

Новый проект собирается в private staging и публикуется после записи всех slides/assets/original. Existing import использует project queue → materials queue → один metadata commit с CAS. Ошибка удаляет только новые файлы импорта. Public/export включают видимые slides/assets, не оригиналы и archives; заметки следуют выбранным share settings.

## Проверки и источники

`node --test test/pptx-import.test.js` проверяет inheritance, rich text вне sampling limits inspector, hidden slides, aspect ratios, transforms, unsafe packages, rollback и concurrent copy/import. `node test/pptx-import-ui.js` проверяет gallery upload, Chromium pixels, движение текста, fill фигур, HTML/reload, private originals, PDF и native text/shapes в экспортированном XML. Synthetic fixtures не подтверждают отображение любого файла в PowerPoint.

Реализация следует [структуре PresentationML Microsoft](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document). Изучались [PPTX2HTML](https://github.com/g21589/PPTX2HTML) MIT, [pptx-renderer](https://github.com/aiden0z/pptx-renderer) Apache-2.0 и [office-kit/pptx](https://github.com/office-kit/pptx) MIT. Их код не копировался; используются существующие JSZip/linkedom/image-size и bounded semantic importer отдельно от reference inspector.
