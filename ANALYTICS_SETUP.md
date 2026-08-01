# ВАРГИ: ежедневный приватный дашборд

Дашборд расположен в `/analytics-dashboard/`, не индексируется и не связан с главной. Файл данных шифруется AES-256-GCM; пароль и API-токены хранятся только в GitHub Actions Secrets.

## Секреты репозитория

- `YANDEX_METRIKA_TOKEN` — OAuth только с правом `metrika:read`.
- `CLARITY_API_TOKEN` — токен проекта из Settings → Data Export.
- `GSC_CLIENT_ID` — OAuth client ID Google.
- `GSC_CLIENT_SECRET` — OAuth client secret Google.
- `GSC_REFRESH_TOKEN` — refresh token со scope `webmasters.readonly`.
- `DASHBOARD_PASSWORD` — отдельный длинный пароль для открытия дашборда.

Ни один секрет нельзя добавлять в код, issue, commit или сообщения. После добавления секретов запустить workflow `Update private analytics` вручную один раз. Далее он запускается ежедневно в 10:10 по Москве.

## Локальная проверка

```bash
MOCK_MODE=1 DASHBOARD_PASSWORD=vargi-test node scripts/update-analytics.mjs
```

Открыть `analytics-dashboard/index.html` через локальный HTTP-сервер и использовать пароль `vargi-test`.
