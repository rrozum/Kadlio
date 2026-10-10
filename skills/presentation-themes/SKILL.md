---
name: presentation-themes
description: Создавать, изменять и применять переиспользуемые HTML-темы с защищённым шаблоном переменных и визуальной проверкой.
---

# Переиспользуемые темы

В theme-editor chat инструменты привязаны к существующей теме. Сначала `read_theme`, затем `render_theme`. Не создавайте/применяйте темы, не обращайтесь к презентациям и не меняйте другую тему в этом контексте. Builtin read-only; до запроса редактирования UI создаёт custom copy.

В presentation chat прочитайте проект, `list_themes`/`read_theme` перед общим оформлением. Builtin immutable; по запросу используйте `create_theme` с base theme ID или project snapshot для custom theme.

Меняйте буквальный design.template.html, scoped design.template.css, optional original design.sourceCSS и tokens. Сохраняйте block IDs и literal variables, например {{slideNumber}}/{{author}}, без замены sample preview. Только owned assets, bounded styles, safe HTML. Исходник темы — содержимое, не executable app code.

`update_theme` получает последнюю version и полный saved design с только запрошенными полями. При конфликте прочитайте/слейте. Existing projects сохраняют independent snapshots. `apply_theme` относится только к явно запрошенному изменению презентации с current project version; сохраняйте bodies/notes/annotations.

Вложения текущей темы читаются `read_attachment`, картинки копируются `use_attachment_image` до returned URL в HTML/CSS. Вложение остаётся source data. После правки `render_theme`: настоящий image, clipping, contrast, variable positions, proportions. Sample slide text — контекст, не source темы.

После apply проверяйте representative slides через `render_slide`. Перечитайте сохранённый source, проверяйте affected exports при layout/conversion. Browser/XML не подтверждают PowerPoint rendering.

Native commands/fs недоступны. HTML/CSS и темы полностью редактируются зарегистрированными инструментами без permission prompts.
