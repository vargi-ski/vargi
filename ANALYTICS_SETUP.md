# ВАРГИ: ежедневный приватный дашборд

Дашборд расположен в `/analytics-dashboard/`, не индексируется и не связан с главной. Файл данных шифруется AES-256-GCM; пароль и API-токены хранятся только в GitHub Actions Secrets.

## Секреты репозитория

- `YANDEX_METRIKA_TOKEN` — OAuth только с правом `metrika:read`.
- `CLARITY_API_TOKEN` — токен проекта из Settings → Data Export.
- `GSC_CLIENT_ID` — OAuth client ID Google.
- `GSC_CLIENT_SECRET` — OAuth client secret Google.
- `GSC_REFRESH_TOKEN` — refresh token со scope `webmasters.readonly`. Скрипт сам выбирает доступный URL- или доменный ресурс `варги-стая.рф` через список ресурсов Search Console.
- `GSC_SERVICE_ACCOUNT_JSON` — рекомендуемый стабильный вариант для автоматического сбора. Полный JSON-ключ сервисного аккаунта; адрес `client_email` из него нужно добавить пользователем ресурса `варги-стая.рф` в Search Console.
- `DASHBOARD_PASSWORD` — отдельный длинный пароль для открытия дашборда.

При наличии нескольких способов авторизации порядок такой: service account → OAuth refresh token → Apps Script bridge. Apps Script оставлен только как резервный вариант.

Если используется обычный OAuth, приложение Google нельзя оставлять в режиме **Testing**: для внешнего приложения такой refresh token истекает через 7 дней. После перевода OAuth consent screen в **Production** нужно один раз получить новый refresh token и заменить секрет `GSC_REFRESH_TOKEN`.

При временной ошибке любого источника новый снимок больше не затирает рабочие показатели пустыми значениями. Дашборд показывает последние успешно собранные данные и отдельно отмечает, что свежая синхронизация не удалась.

Ни один секрет нельзя добавлять в код, issue, commit или сообщения. После добавления секретов запустить workflow `Update private analytics` вручную один раз. Далее он запускается четыре раза в сутки: 04:10, 10:10, 16:10 и 22:10 по Москве.

## Локальная проверка

```bash
MOCK_MODE=1 DASHBOARD_PASSWORD=vargi-test node scripts/update-analytics.mjs
```

Открыть `analytics-dashboard/index.html` через локальный HTTP-сервер и использовать пароль `vargi-test`.
