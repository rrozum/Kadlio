# Уведомления о стороннем коде

Зависимости сохраняют свои лицензии в npm-пакетах. Адаптации ниже дополнительно сохраняют исходную атрибуцию. Юридические тексты лицензий приведены на языке оригинала без изменений.

## SlideForge

- Репозиторий: [vincenzo-afk/SlideForge](https://github.com/vincenzo-afk/SlideForge).
- Закреплённый commit: [`f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f`](https://github.com/vincenzo-afk/SlideForge/tree/f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f).
- Исходники: [`js/slides.js`](https://github.com/vincenzo-afk/SlideForge/blob/f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f/js/slides.js), [`js/ai.js`](https://github.com/vincenzo-afk/SlideForge/blob/f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f/js/ai.js).
- Адаптированные части: `shared/presentation/default-theme.js`, `backend/modules/ai/model-json.js`.
- Изменения: ES-module фабрики HTML титульного/содержательного слайда, scoped CSS палитры, стабильные block IDs и ограниченный JSON-parser. Запросы/ключи провайдера обрабатываются сервером этого приложения.

```text
MIT License

Copyright (c) 2026 Vincenzo AFK

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Интерфейс OpenScreen

- Репозиторий: [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen).
- Закреплённый commit: [`e8b85444f21623a779c53033424511a58a971bf7`](https://github.com/getopenscreen/openscreen/tree/e8b85444f21623a779c53033424511a58a971bf7).
- Исходники: [`src/styles/design-tokens.css`](https://github.com/getopenscreen/openscreen/blob/e8b85444f21623a779c53033424511a58a971bf7/src/styles/design-tokens.css), [`NewEditorShell.module.css`](https://github.com/getopenscreen/openscreen/blob/e8b85444f21623a779c53033424511a58a971bf7/src/components/ai-edition/NewEditorShell.module.css), [`EditorShellV4.module.css`](https://github.com/getopenscreen/openscreen/blob/e8b85444f21623a779c53033424511a58a971bf7/src/components/ai-edition/v4/EditorShellV4.module.css).
- Адаптированные части: `frontend/modules/openscreen.css`, оболочки `frontend/editor.html` и `frontend/projects.html`.
- Изменения: tokens, размеры панелей, типографика, toolbar/inspector и светлые/тёмные варианты. Стиль относится к UI приложения; слайды сохраняют собственные HTML/CSS.

```text
MIT License

Copyright (c) 2025 Siddharth Vaddem

Copyright (c) 2025-2026 OpenScreen contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Шрифт Geist

`frontend/fonts/Geist-Variable.woff2` — неизменённый upstream-шрифт из [`src/assets/fonts/Geist-Variable.woff2`](https://github.com/getopenscreen/openscreen/blob/e8b85444f21623a779c53033424511a58a971bf7/src/assets/fonts/Geist-Variable.woff2). Соответствующая полная лицензия SIL Open Font License 1.1 сохранена в [frontend/fonts/OFL.txt](frontend/fonts/OFL.txt). Шрифт хранится локально для интерфейса приложения и не заменяет выбранные шрифты презентации.

Copyright 2024 The Geist Project Authors ([vercel/geist-font](https://github.com/vercel/geist-font)). Лицензия шрифта отдельна от MIT-лицензии кода приложения.

## Форматтер Prettier

- Версия 3.9.9 из [npm-пакета](https://registry.npmjs.org/prettier/-/prettier-3.9.9.tgz), [upstream](https://github.com/prettier/prettier).
- Локальные файлы: `shared/vendor/prettier-3.9.9/` — standalone ES-module, HTML/PostCSS/Babel/ESTree plugins. Содержимое сохранено, расширение `.js` соответствует MIME-карте сервера.
- MIT, copyright James Long and contributors. Полные [LICENSE](shared/vendor/prettier-3.9.9/LICENSE), [THIRD-PARTY-NOTICES](shared/vendor/prettier-3.9.9/THIRD-PARTY-NOTICES.md) и [provenance.json](shared/vendor/prettier-3.9.9/provenance.json) сохранены.

## Подсветка Prism

- Версия 1.30.0 из [npm-пакета](https://registry.npmjs.org/prismjs/-/prismjs-1.30.0.tgz), [upstream](https://github.com/PrismJS/prism).
- `frontend/vendor/prismjs-1.30.0/` содержит неизменённые core/markup/CSS/clike/JavaScript. Автоподсветка отключена; source editor запускает её явно.
- MIT, copyright (c) 2012 Lea Verou. Полная [LICENSE](frontend/vendor/prismjs-1.30.0/LICENSE) и [checksums](frontend/vendor/prismjs-1.30.0/provenance.json) сохранены; цвета/controls редактора относятся к приложению.

## Иконки Lucide

- `lucide-static` 1.52.0 из [npm-пакета](https://registry.npmjs.org/lucide-static/-/lucide-static-1.52.0.tgz), [upstream](https://github.com/lucide-icons/lucide).
- `shared/vendor/lucide-1.52.0/catalog.js` — экспорт исходных icon-nodes/tags в ES-module. Геометрия и tags не изменены; русские labels, поиск и HTML insertion — код приложения. CDN/сетевой icon font не нужны.
- ISC, copyright (c) 2026 Lucide Icons and Contributors; производные Feather сохраняют MIT Cole Bemis. Обе лицензии в [LICENSE](shared/vendor/lucide-1.52.0/LICENSE), checksums в [provenance.json](shared/vendor/lucide-1.52.0/provenance.json).

## Профиль seccomp Moby

- [moby/profiles](https://github.com/moby/profiles), commit [`2ceae35d351c156cb5a8efc0fdc4a08cf94569d8`](https://github.com/moby/profiles/tree/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8), исходник `seccomp/default.json`.
- `docker/seccomp.json` добавляет namespace/mount syscalls для сохранения bubblewrap внутри non-root контейнера. Остальные default-правила сохранены.
- Полная Apache-2.0 лицензия: [docker/LICENSE.moby](docker/LICENSE.moby); источник, checksum и изменение: [docker/provenance.json](docker/provenance.json). [Описание границы](docs/docker.md).
