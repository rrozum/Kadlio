# Открытые основы AI-презентаций

Первичные репозитории и файлы лицензий были проверены 7 октября 2026 года при выборе основы. Ниже описаны возможности upstream на момент выбора; они не становятся возможностями этого приложения автоматически.

| Проект | Полезные возможности | Проверенная лицензия | Соответствие этому редактору |
| --- | --- | --- | --- |
| [Presenton](https://github.com/presenton/presenton) | ИИ-генерация, HTML-шаблоны, OpenAI-совместимые провайдеры, MCP, PPTX/PDF | [Apache-2.0](https://github.com/presenton/presenton/blob/main/LICENSE) | Референс шаблонов/экспорта; FastAPI/Next.js значительно увеличил бы существующий Node/HTML проект |
| [Deckium](https://github.com/sleipner42/Deckium) | Общая презентация для ручной и разговорной правки | [MIT с атрибуцией Electron React Boilerplate](https://github.com/sleipner42/Deckium/blob/main/LICENSE) | Полезный UI-референс; Electron/React и собственная модель документа менее удобны как основа веб-HTML |
| [SlideForge vincenzo-afk](https://github.com/vincenzo-afk/SlideForge) | ИИ-контент/темы, обычный HTML/CSS/JS, inline text, совместимые API, PPTX/PDF | [MIT](https://github.com/vincenzo-afk/SlideForge/blob/main/LICENSE) | Небольшая основа фабрик шаблонов/палитры/JSON без переноса всего приложения |
| [SlideForge gitstq](https://github.com/gitstq/SlideForge) | Отдельный генератор презентаций с заявленными PPTX/PDF/HTML | [MIT](https://github.com/gitstq/SlideForge/blob/main/LICENSE) | Дополнительный референс; это другой репозиторий, несмотря на одинаковое имя |

## Что использовано

Выбран **vincenzo-afk/SlideForge**, commit `f3f4d3dbebe0c560c5dfd13791e3581772dd7e4f`. Это небольшая адаптация в уже существующий редактор, а не полный fork.

`shared/presentation/default-theme.js` содержит адаптированный рендер title/content и palette tokens. `backend/modules/ai/model-json.js` содержит адаптированный нормализатор JSON для server-side tool arguments. [Уведомления](../THIRD_PARTY_NOTICES.md) сохраняют файлы, изменения и MIT.

Просмотрщик, авторизация, server persistence, аннотации, ACP, MCP, публичные ссылки и Chromium/PptxGenJS export являются компонентами этого приложения. API-ключи и данные хранятся на сервере, а не в browser localStorage.

Результат сравнения generation quality или точности экспорта по README upstream не выводился. Для него нужно тестировать приложения на одинаковых входах и открывать результат в целевом ПО.

## Визуальный референс

Из [OpenScreen](https://github.com/getopenscreen/openscreen), commit `e8b85444f21623a779c53033424511a58a971bf7`, адаптированы tokens, размеры панелей, типографика и editor shell в `frontend/modules/openscreen.css` и HTML приложения. [MIT upstream](https://github.com/getopenscreen/openscreen/blob/e8b85444f21623a779c53033424511a58a971bf7/LICENSE) проверена при выборе.

Это отдельный визуальный источник. UI-тема относится к app controls, а презентации сохраняют собственные шрифты/палитру/HTML. Локальный Geist сохраняет полную SIL OFL 1.1. Точная атрибуция — в [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
