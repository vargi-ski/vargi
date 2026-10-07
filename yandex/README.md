# Тестовый Yandex API Gateway для барахолки ВАРГИ

Первый этап — **preview только чтения** через Yandex к существующему Railway. Аккаунт, платные ресурсы, DNS и production frontend этим набором не изменяются. Нынешняя форма и админка продолжают использовать Railway до отдельной приёмки отправки.

`openapi.yaml` — **первая спецификация: GET и локальный OPTIONS**, без POST; `console-settings.json` — памятка полей ресурса, **не тело запроса Yandex API**. Шлюз создаётся в регионе **Россия**. Регион выбирается аккаунтом/консолью и не задаётся полем OpenAPI. Имя: `vargi-market-public-test`, таймаут ресурса: 60 секунд, логирование выключено, пользовательская сеть и сервисный аккаунт не нужны для публичного HTTP origin. Production NS и CNAME остаются прежними до приёмки.

`openapi-full.pending.yaml` и `console-settings-full.pending.json` — отдельный **pending-вариант**, не готовый к включению. Он добавляет приватную Function для подписанного POST и новый bounded-photo backend route. Placeholders `FUNCTION_ID` и `SERVICE_ACCOUNT_ID` не являются существующими ресурсами. Прямого HTTP POST к нынешнему `/submit` нет ни в одной спецификации.

## Разрешённые маршруты

| Клиент | Фиксированный Railway upstream |
|---|---|
| `GET /health` | `/health` |
| `GET /listings` | `/listings` |
| `GET /listings/{id}` | `/listings/{id}` |
| `GET /listings/{id}/photos/{filename}` | `/listings/{id}/photos/{filename}` |
| `OPTIONS` на этих четырёх путях | локальный CORS/preflight, без запроса к Railway |

Только в **full.pending** добавляется `POST /submit` → приватная Function → подписанный Railway `/gateway/submit`; на этом пути OPTIONS также локальный. Публичный путь фото остаётся `/listings/{id}/photos/{filename}`, но full.pending отправляет его на `/gateway/photos/{id}/{filename}`: backend должен вернуть JPEG с ограниченным объёмом. До готовности Function и backend pending не включать.

Origin всегда `https://market-api-production-d9ab.up.railway.app`. Не заменять его на `market.…`, если этот домен будет указывать на Gateway: возникнет петля. Нет catch-all, жадных параметров и `any-method`; нет `/admin`, `/market`, `/robots.txt` и произвольных путей. Параметры пути валидируются; ID соответствует текущей проверке Railway, имя фото — безопасное имя одного файла. Админка и её bearer-токен продолжают обращаться прямо к Railway.

HTTP GET передаёт только `Host`, `Origin`, `Accept` и исходные query-параметры; `User-Agent` шлюз передаёт по умолчанию. `Authorization`, `Cookie`, клиентские `Forwarded`, `X-Forwarded-*`, `X-Real-IP` и произвольный `X-Request-Id` не копируются. Wildcard mapping заголовков нет. В pending POST Function получает payload **2.0**, восстанавливает multipart bytes с учётом `isBase64Encoded` и сохраняет исходный `Content-Type` **вместе с boundary**; не фиксировать `multipart/form-data` без boundary. В YAML нет body/JSON mapping. Signer использует фиксированный `/gateway/submit` и отклоняет непустой POST query; приложенческий idempotency key остаётся `requestId` внутри multipart. Trace создаёт backend, Function возвращает проверенный `X-Request-Id` ответа.

CORS первой спецификации разрешает два существующих origin сайта и `GET`, `OPTIONS`; pending добавляет POST. Без credentials. Для preflight разрешён только `Content-Type`. `Retry-After` и серверный `X-Request-Id` доступны браузеру. `Origin` передаётся в Railway, поэтому нынешняя backend-проверка origin сохраняется. Отсутствующий origin допустим для curl и навигационных запросов. Другой origin отклоняется валидатором параметров. CORS не заменяет авторизацию.

## Блокирующие проверки перед переключением формы

1. **Полный запрос и ответ Gateway — не более 2,5 МБ.** Это технический лимит, его нельзя увеличить. Суммируются все фото одного multipart, поля и служебное оформление. Исходная Railway форма могла подготовить отдельный JPEG до 2300 КиБ, несколько фото и HEIC до 8 МиБ. Gateway-клиент должен уменьшать общий набор с запасом либо показывать понятную ошибку, сохраняя фото и поля. Серверная конвертация происходит после входного ограничения. Function дополнительно имеет предел 3,5 МБ JSON с Base64 и метаданными; проверить максимальный разрешённый набор на обоих пределах. Перед включением формы проверить JPEG и HEIC на Mac/iPhone.
2. **Первый preview проверяет только GET.** HTTP docs подтверждают проксирование, но отдельно не описывают сохранение бинарных байтов. Сравнить хеш и `Content-Type` небольшого опубликованного фото Gateway/Railway, проверить oversized response. Локальные config tests не подтверждают Cloud runtime. Отдельным этапом с pending Function/backend: одна согласованная тестовая заявка и повтор **того же** `requestId` — одна запись и неизменные поля; ошибки сохраняют черновик. Не отправлять POST через первую GET-only спецификацию.
3. **Прямой HTTP POST заблокирован из-за неизвестного IP trust.** Для `type: http` docs не описывают надёжное overwrite/append XFF; текущий backend `trust proxy = 1` и 6/15 минут по `req.ip` может объединить посетителей по IP прокси. Нельзя брать первый XFF, доверять `X-Real-IP` или менять `trust proxy` на `true`. Pending использует приватную Function: IP только из документированного `event.requestContext.http.sourceIp`; HMAC headers отправляются в фиксированный `/gateway/submit`. Backend проверяет подпись, timestamp, request/path/body и лимитирует проверенный IP. Function должна оставаться приватной: только аккаунту шлюза `functions.functionInvoker` на конкретную Function; без `allUsers`/`allAuthenticatedUsers`, иначе JSON caller может подделать context. Секрет только в env Function/backend, route выключен без отдельного secret; YAML/frontend/репозиторий его не содержат. Signer/backend runtime и replay/IP tests обязательны отдельно, OpenAPI их не реализует. Использовать проверенный tag `gateway-submit-reviewed`, не `$latest`.
4. Проверить GET списка/карточки, 404 неопубликованного фото, ошибки backend, CORS, локальный OPTIONS, отсутствие POST `/submit` в preview, запрет `/admin` и неожиданных методов. Затем отдельно timeout/413/429 pending-отправки и сохранение черновика. Нельзя автоматически повторять POST с новым `requestId` после сетевой ошибки. DNS переключать только после приёмки всей схемы, не после первого успешного GET.
5. Проверить endpoint из сети посетительницы. Доступность Yandex в этой сети и связь Gateway → Railway ещё не измерены; неизвестную причину исходного MacBook-сбоя считать неустановленной.

Клиентский контракт для отдельного opt-in теста:

```js
window.VARGI_MARKET_CONFIG = {
  transport: 'gateway',
  gatewayEndpoint: 'https://<служебный-домен-шлюза>'
};
```

Пустой/default config продолжает нынешний Railway transport. Первый preview использовать только для каталога; form opt-in с GET-only YAML не включать. URL фото клиент переписывает с известного Railway origin на Gateway, сохраняя `/listings/{id}/photos/{filename}`; произвольные URL не заменять. Админка использует legacy. Production config/DNS — после полной приёмки; откат — убрать opt-in. Свой домен первому тесту не нужен.

Для служебного Gateway endpoint добавить **его точный HTTPS origin** в `connect-src` и `img-src` CSP тестовой страницы; wildcard `*.apigw.yandexcloud.net` не добавлять. Действующий CSP сейчас разрешает только существующие домены. Крупный HEIC без поддержки декодирования в браузере пока не проходит предел Gateway: форма сохраняет черновик и показывает ошибку. Перед включением требуется реальная проверка JPEG/PNG/WebP/HEIC на устройствах пользователей; mock canvas в unit tests не проверяет браузерные кодеки.

## Приватная Function и backend: порядок подготовки pending

1. Проверить локальные тесты, затем собрать ZIP: `python3 yandex/function/build.py /tmp/vargi-gateway-submit.zip`. Builder отказывается перезаписывать существующий файл и включает только `index.js`/`submit.mjs`; env и зависимости не попадают в ZIP.
2. Создать приватную Function: runtime **Node.js 22**, entrypoint **`index.handler`**, timeout **120 секунд**, память первоначально 128 МБ, logging выключен. Не включать minimum/provisioned instances. Опубликовать проверенную версию с tag `gateway-submit-reviewed`.
3. В защищённых env Function и Railway установить одинаковый новый `GATEWAY_SUBMIT_SECRET`: ровно 64 строчных hex-символа (32 случайных байта). Никогда не записывать значение в YAML, frontend, Git или сводки. Backend новые submit/photo routes возвращают 503 до валидного secret.
4. Развернуть только проверенный точный backend commit; не снимать существующий Railway pin на moving main. Назначить service account шлюза `functions.functionInvoker` только на эту Function. Подставить реальные ID в pending YAML. Gateway full resource timeout **120 секунд**, Function upstream timeout 105 секунд, клиентская отправка — одна попытка до 120 секунд. GET upstream read timeout остаётся 30 секунд.
5. Полный сериализованный multipart ограничен клиентом, Function и backend до **2 000 000 байт**. Подписываются исходные байты, boundary, IP, время и nonce; backend проверяет их до записи и отправки уведомлений. Проверка nonce ограничена одним backend процессом, до 10 000 активных записей; долговечное устранение дублей обеспечивает прежний `requestId`.
6. Full фото endpoint проверяет публикацию до и после преобразования, возвращает JPEG ≤2 000 000 байт с `no-store`, не меняет оригинал. Одновременно допускает два преобразования; input ограничен 16 Мп. Его 503/404 также проверить через Cloud Gateway.
7. Только после живых проверок и проверки проблемной Wi-Fi сети включать transport у пользователей. Этот пакет не создаёт Cloud ресурсы и не переключает DNS.

Пример **read-only** проверки preflight после независимого создания тестового шлюза:

```bash
curl -i -X OPTIONS 'https://<служебный-домен-шлюза>/listings' \
  -H 'Origin: https://xn----7sbbfg4a6clj5k.xn--p1ai' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: content-type'
```

Cache: эта спецификация не добавляет edge/CDN-кеш и не преобразует upstream response. `Cache-Control: no-store` карточек/фото и статусы 404 должны сохраниться. Список клиент запрашивает с `cache: 'no-store'`; Gateway не подменяет его cache headers. После модерации/удаления проверить карточку и фото ещё раз. Query и тело POST никогда не использовать как cache key.

## Расходы и права

На 07.10.2026 каждый календарный месяц первые **100 000 запросов** и **100 ГБ исходящего трафика** Gateway не тарифицируются; выше — **142,30 ₽/1 млн запросов** с НДС. 1 млн общих запросов = `(1 000 000 − 100 000)/1 000 000 × 142,30` = **128,07 ₽**, при трафике в бесплатном объёме. Это регулярный free tier, не временный grant. Фото, OPTIONS, ошибки и повторные обращения нельзя заранее исключать из расчёта числа запросов. Нынешняя оплата Railway сохраняется. При превышении квот/трафика нет гарантированного потолка 300 ₽.

При ручном пополнении без привязанной карты минимальный начальный депозит — 300 ₽ на баланс, не месячная подписка. Физлица сейчас начинают сразу платное потребление после верификации; отдельного trial для них нет. Нельзя рассчитывать текущий monthly budget за счёт стартового grant.

Логирование выключить в поле **Логирование → Запись логов**. CLI эквивалент `--no-logging`, Terraform — `log_options { disabled = true }`. Это настройка ресурса, не OpenAPI. При временной диагностике минимальный уровень ERROR/WARN, короткий retention и контроль расходов; не записывать тела заявок, фото, bearer-токены, контакты или полные query. Cloud Logging отдельно тарифицируется; free tier — 5 ГБ записи/1 ГБ хранения в месяц на платежный аккаунт.

Для создания/изменения шлюза достаточно `api-gateway.editor` на выбранном каталоге, просмотра — `api-gateway.viewer`; общие `editor/admin` на весь проект не нужны. Preview не требует Function/Storage/YDB IAM. Pending invoker получает `functions.functionInvoker` только на signer Function; назначение/использование его IAM требует отдельных полномочий оператора, не широких runtime-прав. Billing отдельно.

В pending первые 1 млн вызовов Function и 10 ГБ×час исполнения ежемесячно бесплатны; далее 18,97 ₽/1 млн вызовов и 6,48 ₽/ГБ×час. Сетевое ожидание proxy fetch тоже занимает время вызова; проверить реальную длительность. Не включать provisioned/minimum instances. Logging выключить также на Function.

Установить уведомления бюджета 100/200/300 ₽ на потребление выбранных ресурсов. **Бюджет отправляет уведомления и не останавливает потребление.** Старые расширения Gateway `x-yc-apigateway-rate-limit(s)` текущая документация помечает устаревшими и больше не поддерживаемыми; в YAML они не добавлены. Официальная замена — Smart Web Security, но она имеет отдельную тарификацию и требует отдельной настройки/расчёта; не включать её автоматически как «бесплатный cap». И backend limit, и оповещения не являются жёстким финансовым kill switch.

## Почему прямой Serverless Container не решает большие HEIC

| Вход | Запрос / ответ |
|---|---|
| API Gateway | 2,5 МБ / 2,5 МБ |
| Прямой HTTPS endpoint Serverless Container | 3,5 МБ с заголовками и телом / 3,5 МБ с заголовками и телом |

Прямой контейнер добавляет только 1 МБ; исходные HEIC и общий multipart всё равно могут превышать предел. Его публичный endpoint удаляет входящие `Authorization` и `Cookie`, а из ответа удаляет `X-Request-Id`. Это не прозрачный proxy существующей админки. Описанное для прямого контейнера добавление IP в XFF нельзя переносить на интеграцию `type: http`. Перенос backend в контейнер дополнительно требует постоянного хранения в YDB/Object Storage вместо локального volume. Такой перенос не включён в текущий тест.

## Локальная проверка

Нужны Python 3 и PyYAML. Проверка не обращается к Cloud/Railway, не создаёт заявки и не обещает acceptance платформы:

```bash
python -m unittest discover -s yandex/test -v
cd market-api && npm ci && npm test
```

Проверяются allowlist/default отсутствие POST, fixed upstream без петли, изоляция credential/IP headers, обязательная private Function для pending POST, multipart boundary, отсутствие body transforms/старых rate limits, CORS, settings и безопасные path values. Platform acceptance и signer/backend runtime tests отдельно.

## Официальные источники, сверены 07.10.2026

- [HTTP integration: headers/query/метод/таймауты](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/http).
- [Private Function/payload 2.0/sourceIp](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/cloud-functions), [Function IAM](https://yandex.cloud/ru/docs/functions/security/), [публичный allUsers invocation — здесь запрещён](https://yandex.cloud/ru/docs/functions/operations/function/function-public), [Function limits](https://yandex.cloud/ru/docs/functions/concepts/limits), [Function price](https://yandex.cloud/ru/docs/functions/pricing).
- [CORS](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/cors), [валидация параметров](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/validator), [повторное использование integration](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/).
- [Лимиты Gateway](https://yandex.cloud/ru/docs/api-gateway/concepts/limits), [сеть по умолчанию/IPv4](https://yandex.cloud/ru/docs/api-gateway/concepts/networking).
- [Создание Gateway](https://yandex.cloud/ru/docs/api-gateway/operations/api-gw-create), [регионы](https://yandex.cloud/ru/docs/overview/concepts/region), [служебный endpoint](https://yandex.cloud/ru/docs/api-gateway/quickstart/), [свой домен через CNAME](https://yandex.cloud/ru/docs/api-gateway/operations/api-gw-domains).
- [Цены Gateway](https://yandex.cloud/ru/docs/api-gateway/pricing), [регулярный free tier](https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier), [первоначальное пополнение](https://yandex.cloud/ru/docs/billing/operations/pay-the-bill), [регистрация физлица](https://yandex.cloud/ru/docs/billing/quickstart/).
- [Роли Gateway](https://yandex.cloud/ru/docs/api-gateway/security/), [выключение логирования](https://yandex.cloud/ru/docs/api-gateway/operations/api-gw-logs-write), [бюджет — только уведомления](https://yandex.cloud/ru/docs/billing/concepts/budget), [старые rate limits устарели](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/rate-limit).
- [Вызов прямого Container и фильтрация заголовков](https://yandex.cloud/ru/docs/serverless-containers/concepts/invoke), [лимиты Container](https://yandex.cloud/ru/docs/serverless-containers/concepts/limits).
