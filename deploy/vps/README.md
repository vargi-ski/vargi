# Сайт и барахолка на одном сервере

Это подготовленная конфигурация для VPS с Docker Engine и Compose **2.30+**. Она не развёртывает сервер, не покупает услуги и не меняет DNS. Основной сайт продолжает работать до отдельного проверенного переключения.

Снаружи открыты только HTTPS сайта и HTTP для получения сертификата/редиректа. Caddy отдаёт страницы и `/api/market/*` передаёт внутреннему `market-api:3000`, удаляя префикс. API не публикует свой порт. Адреса фото формирует API с `PUBLIC_API_PREFIX=/api/market`, поэтому посетителю не нужен отдельный доступ к Railway.

Сборщик копирует только публичные разделы, ассеты и календарные JSON из репозитория. Данные объявлений лежат в отдельном `DATA_PATH`, который никогда не монтируется в Caddy. Backend, Git, тесты, операции и секреты в публичную файловую систему не попадают; symlink внутри публичного дерева останавливает сборку. Настройка `assets/board-runtime.js` в образе переключает барахолку на единственный текущий origin; исходная настройка GitHub Pages сохраняется. HTML барахолки, runtime, API, фотографии и ответы с ошибками имеют `Cache-Control: no-store`.

## Подготовка тестового VPS

1. Выбрать отдельное тестовое имя и направить **только его** A-запись на VPS. Использовать ASCII/punycode; основной домен и NS пока сохраняются.
2. Проверить обновления ОС, SSH по ключу, firewall: 80/443 открыты, SSH ограничен, 3000 закрыт. Сначала проверить доступность VPS из проблемной Wi-Fi сети.
3. Получить полный checkout нужного commit в `/opt/vargi/app`. Репозиторий хранит код; приватный каталог данных и env лежат отдельно.
4. На сервере подготовить каталоги:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /srv/vargi/stage-data
sudo install -d -m 700 -o 1000 -g 1000 /srv/vargi/stage-tmp
sudo install -d -m 700 /etc/vargi
```

В `/etc/vargi/stage-api.env` записать **новый случайный** `ADMIN_SESSION_SECRET` длиной от 32 символов, затем `chmod 600`. Не печатать значение, не вставлять в чат и не коммитить. Формат файла — raw `KEY=value`, без кавычек и интерполяции. Для тестовой копии только эта переменная: ни Telegram, ни S3, ни setup/recovery production token.

```sh
export SITE_HOST=stage.example.net
export SITE_ORIGIN=https://stage.example.net
export PRIVATE_ENV_FILE=/etc/vargi/stage-api.env
export DATA_PATH=/srv/vargi/stage-data
export PRIVATE_TMP_PATH=/srv/vargi/stage-tmp
export RELEASE_TAG=reviewed-commit
export MIGRATION_READ_ONLY=1
export AUTO_MAINTENANCE_DISABLED=1
node deploy/vps/preflight.mjs
docker compose -f deploy/vps/compose.yml config --quiet
docker compose -f deploy/vps/compose.yml build
docker compose -f deploy/vps/compose.yml up -d
```

Имя `stage.example.net` — placeholder, заменить своим. `preflight` проверяет HTTPS/origin, внешние пути, права, владельца данных/временного каталога и обязательный session secret; не выводит секреты. `DATA_PATH`, `PRIVATE_TMP_PATH` и `PRIVATE_ENV_FILE` не должны совпадать или находиться друг внутри друга. Запускать из корня checkout. Не использовать обычный `docker compose config` в логах/чате: он может вывести значения env.

`PRIVATE_TMP_PATH` — отдельный приватный каталог на диске, смонтированный только в API как `/tmp`; Caddy к нему доступа не имеет. API собирает там полный архив volume перед загрузкой в резервное хранилище. Свободного места на его файловой системе должно хватать как минимум на полный несжатый размер `DATA_PATH` с запасом; контролировать объём и остаток места. Небольшой tmpfs ограничил бы размер backup и мог бы сорвать резервирование. Не размещать временные архивы внутри данных или checkout. Проверять права 700 и UID 1000; не удалять архив, пока backup не завершился успешно.

Compose по умолчанию запускает **копию только для чтения** и отключает автоматическое удаление старых записей, резервирование и уведомления. Импортировать проверенный snapshot штатным `migration-data.py`, включая фотографии, auth и настройки Telegram; синтаксис и проверку целостности см. [руководство миграции](MIGRATION.md). Импорт требует нового несуществующего пути, затем он становится `DATA_PATH`; первоначальный пустой каталог из примера подходит для запуска без реальных данных. После импорта подтвердить владельца 1000:1000 и режим 700 каталога данных. Не подключать тестовый API к живому volume Railway.

## Проверки перед переключением

- `/`, `/shop/`, `/nutrition/`, календарь и привычные ссылки открываются.
- `/board/`, карточки и все фотографии используют новый домен с `/api/market/`.
- `/api/market/health` сообщает `ok: true`; `/api/market/listings` возвращает ожидаемые объявления.
- При остановленном API главная страница остаётся доступна. `/market-api/server.js`, `/.env`, `/data/submissions/` и неизвестные API-пути дают 404.
- Провести проверку с ПК и телефона на проблемной Wi-Fi, с мобильного интернета и независимой сети. На read-only копии отправка/изменение/удаление отклоняются.
- Для проверки всей цепочки отправки и модерации использовать отдельный пустой тестовый каталог данных и отдельного администратора, явно установив `MIGRATION_READ_ONLY=0`; уведомления и production backup credentials остаются отключены. После теста вернуть режим чтения и проверенный snapshot.

Docker healthcheck проверяет API и запись в volume каждые 30 секунд, но **сам не отправляет тревоги и не перезапускает unhealthy контейнер**. `restart: unless-stopped` восстанавливает завершившийся процесс. Внешний мониторинг HTTPS, health, списка и фотографии с уведомлением требует отдельной настройки и проверки доставленного сигнала.

## Финальный перенос и откат

Перед cutover закрыть запись в старый API, дождаться завершения активных запросов, экспортировать свежий snapshot и проверить его целостность. Сверить количество, статусы и хеши фото после импорта. Новый API включать для записи только после финального импорта, настройки резервных копий и подтверждения переключения. Не включать запись одновременно на двух независимых volume.

Для production заменить `SITE_HOST`/`SITE_ORIGIN`/`DATA_PATH`/`PRIVATE_TMP_PATH`/`PRIVATE_ENV_FILE`, сохранить новый сильный `ADMIN_SESSION_SECRET`; отключение read-only и maintenance задаётся явно `MIGRATION_READ_ONLY=0`, `AUTO_MAINTENANCE_DISABLED=0`. При смене session secret администратору потребуется новый вход, пароль из импортированного auth-файла сохраняется.

Секретный production env может содержать `ADMIN_SETUP_TOKEN`, `ADMIN_RECOVERY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`. Значения не хранятся в репозитории. До открытия записи проверить восстановление из внешнего backup, затем Telegram тестовую доставку.

Менять A-записи apex и существующий www CNAME согласованно; текущие NS REG.RU остаются. Caddy получает сертификат, когда hostname разрешается на VPS и доступны 80/443. Не включать принудительный долгий HSTS preload на тестовом адресе.

Для www есть отдельный override `compose.www.yml`: включать только для production после подготовки DNS alias, с `WWW_HOST=www.SITE_HOST`. Запуск: `docker compose -f deploy/vps/compose.yml -f deploy/vps/compose.www.yml up -d`. Alias только перенаправляет на canonical HTTPS. Тестовый запуск не пытается получать сертификаты основного/www домена.

Старый сайт и Railway сохранить на время наблюдения. Для отката до появления новых записей вернуть прежние DNS и старую frontend runtime. Если новый сервер уже принимал заявки, сначала закрыть запись и перенести новые данные обратно; простой DNS откат потеряет видимость этих заявок. Не применять `docker compose down -v`: это удаляет volume сертификатов. Перед обновлением сохранять проверенный commit/image tag и snapshot; rollback образа сам по себе не откатывает данные.

## Автоматические проверки

```sh
node --test deploy/vps/test/*.test.mjs
```

Workflow `VPS migration checks` проверяет приватность сборки, default read-only конфигурацию, Compose, оба Caddyfile, сборку контейнеров и реальные HTTP-маршруты через mock API, включая предел тела 32 MB и доступность главной при отказе API. Проверка из реальной российской сети и внешний мониторинг не заменяются CI.

Официальные источники: [Caddy handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path), [лимит request_body](https://caddyserver.com/docs/caddyfile/directives/request_body), [deferred headers](https://caddyserver.com/docs/caddyfile/directives/header), [ошибки](https://caddyserver.com/docs/caddyfile/directives/handle_errors), [HTTPS](https://caddyserver.com/docs/automatic-https), [Compose raw env_file](https://docs.docker.com/reference/compose-file/services/#format).
