# Docker Compose

В поставке один сервис `presentations`. Node.js 24, npm-зависимости из lockfile, соответствующий Chromium, LibreOffice Impress и bubblewrap находятся в образе. Frontend и shared обслуживаются тем же HTTP-сервисом без отдельной сборки.

## Запуск

```sh
cp .env.example .env
# Перед запуском задайте ADMIN_USERNAME и ADMIN_PASSWORD в .env.
docker compose up --build -d
docker compose ps
```

В пустой базе первый владелец создаётся автоматически из `ADMIN_USERNAME` и `ADMIN_PASSWORD`. Пароль должен содержать 16–256 символов. При заполнении только одного поля приложение сообщает об ошибке; данные пароля в журнал не выводятся. После создания аккаунта эти переменные больше не меняют пользователей и сессии. Установка с существующей базой работает и без них.

Контейнер внутри слушает `0.0.0.0:3210`; на компьютере порт опубликован как `127.0.0.1:3210`. `PUBLIC_ORIGIN` должен точно совпадать с используемым адресом браузера, без завершающего slash. Для другого локального порта задайте, например, `PORT=33210` и `PUBLIC_ORIGIN=http://127.0.0.1:33210`.

Процесс работает под `node` (UID/GID 1000), root filesystem readonly, временные задания используют tmpfs `/tmp`; private data сохраняются в named volume. Docker init собирает дочерние процессы. Не подключайте Docker socket или host root.

## Смена пароля

Изменение `ADMIN_PASSWORD` в `.env` не сбрасывает пароль существующего пользователя. Для явной смены используйте CLI; `admin` в команде замените своим логином:

```bash
read -rsp 'Новый пароль: ' presentation_password
printf '\n'
printf '%s' "$presentation_password" | docker compose exec -T presentations node backend/cli/user.js admin
unset presentation_password
```

Команда меняет пароль и завершает прежние сессии этого пользователя. Войдите снова с новым паролем. Если передан ещё не существующий логин, CLI создаёт аккаунт: проверьте написание логина перед запуском.

## Office sandbox и профиль ядра

Обычный Docker seccomp блокирует создание namespaces, нужных bubblewrap. `docker/seccomp.json` основан на закреплённой версии [Moby default profile](https://github.com/moby/profiles/tree/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp). Он добавляет только syscalls `clone`, `unshare`, `setns`, `mount`, `umount2`, `pivot_root` для private user/mount namespaces, сохраняя остальные правила. Источник, checksum и изменение записаны в `docker/provenance.json`, полная Apache-2.0 лицензия — в `docker/LICENSE.moby`.

Compose не использует `privileged`, `seccomp=unconfined` или `CAP_SYS_ADMIN`: все capabilities сброшены, `no-new-privileges` включён. Bubblewrap дополнительно ограничивает файловую видимость конвертера и его сеть; custom Docker profile не заменяет эту границу.

На ядре/LSM, запрещающем unprivileged user namespaces, изолированный Office preview может быть недоступен. Приложение сообщает ошибку и не запускает LibreOffice без sandbox. Настройка host policy относится к оператору; не обходите ограничение повышением полномочий всего сервиса. [Docker seccomp](https://docs.docker.com/engine/security/seccomp/), [reference renderer](reference-import.md).

## ACP и приватная авторизация

Образ содержит текущий `codex-acp`, но не содержит чьей-либо авторизации. Без операторского account state реальный запрос Codex потребует входа; работоспособность API-провайдера не зависит от этого mount.

Для уже авторизованного аккаунта создайте локальный `compose.private.yaml`:

```yaml
services:
  presentations:
    environment:
      CODEX_HOME: /run/codex-auth
    volumes:
      - type: bind
        source: ${PRESENTATION_CODEX_AUTH_DIR}
        target: /run/codex-auth
        read_only: true
```

В приватной `.env` задайте `PRESENTATION_CODEX_AUTH_DIR` — существующий каталог с `auth.json`. Он должен быть читаем UID 1000 внутри контейнера. Не делайте файл общедоступным ради запуска и не переносите глобальный config оператора в рабочее окружение модели.

```sh
docker compose -f compose.yaml -f compose.private.yaml up --build -d
```

ACP создаёт собственные HOME/CODEX_HOME в private volume и копирует только auth.json. Уже обновлённая приватная авторизация не перезаписывается автоматически; обновление существующих workspaces после повторного входа — операторская операция. Ни mounts, ни контейнер не дают модели terminal/filesystem capabilities. Native/unknown permissions по-прежнему отклоняются.

Другой адаптер устанавливается в производный образ или монтируется оператором и выбирается `ACP_COMMAND`/`ACP_ARGS_JSON`. Произвольный executable имеет права сервиса и должен быть доверенным. Не монтируйте auth другого пользователя для тестирования.

## Необязательный whisper.cpp

Резервное распознавание требует отдельно подготовленных Linux CLI и многоязычной GGML-модели. Они не загружаются автоматически, не входят в базовый образ и не требуются для редактирования/экспорта.

Добавьте в тот же private override read-only mount подготовленного каталога:

```yaml
services:
  presentations:
    environment:
      WHISPER_COMMAND: /opt/whisper/bin/whisper-cli
      WHISPER_MODEL: /opt/whisper/models/ggml-base.bin
    volumes:
      - type: bind
        source: ${PRESENTATION_WHISPER_DIR}
        target: /opt/whisper
        read_only: true
```

CLI должен соответствовать Linux/архитектуре образа и иметь все зависимости; macOS/Windows binary не подойдёт. Для повторяемой поставки можно установить CLI в производный образ, сохраняя модель отдельным private mount. Запись ограничена текущим WAV-протоколом и живёт только во временном каталоге. [Диктовка](dictation.md).

## Сохранение и резервная копия

Обычные `up --build` и `down` не удаляют named volume. `down -v` уничтожает его. До этой команды сохраните нужные данные отдельно.

Для файлового backup остановите приложение и скопируйте весь volume, включая SQLite, token, ai и resources. Не копируйте только presentation.json: оригиналы, assets, темы и авторизация тоже связаны с установкой. Проверяйте восстановление в отдельном Compose project с собственным портом/volume.

Если вместо named volume используется bind mount, заранее подготовьте каталог с правами для UID/GID 1000. Compose не выполняет автоматический chown host-данных.

## Проверки и ограничения

Healthcheck читает `/login` внутри контейнера. Он подтверждает HTTP-запуск, но не ответ модели, Office-конверсию или точность PPTX.

После сборки проверьте вход, проект, theme editor, заметки, аннотацию, save/reload, перестановку и экспорт. Для Office preview проверяйте реальный нейтральный PPTX в sandbox, а не только наличие бинарника. Тесты и реальная авторизация модели описываются отдельно.

Для публикации через HTTPS reverse proxy задайте публичный origin и доступ proxy к приватному listener. Не выставляйте HTTP listener в интернет, не удаляйте Host/Origin проверки и не отключайте authentication.
