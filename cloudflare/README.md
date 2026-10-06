# Cloudflare edge-прокси для барахолки ВАРГИ

Цель: браузер пользователя обращается только к тому же домену сайта:

`https://варги-стая.рф/api/market/*`

Cloudflare Worker проксирует эти запросы в Railway:

`https://market-api-production-d9ab.up.railway.app/*`

Так браузер больше не зависит от прямой доступности доменов Railway и отдельного поддомена market.

## Что уже подготовлено

- Worker: `cloudflare/worker.js`
- конфигурация Wrangler: `cloudflare/wrangler.toml.example`
- фронтенд сначала пробует same-origin `/api/market`
- если Worker ещё не подключён, фронтенд автоматически откатывается на текущие адреса Railway
- GET каталога и карточек кэшируются на edge
- фотографии кэшируются до 30 дней
- отправка заявок, health и admin не кэшируются

## Безопасный порядок включения

1. Добавить домен `xn----7sbbfg4a6clj5k.xn--p1ai` в Cloudflare.
2. Перед сменой NS перенести в Cloudflare все действующие DNS-записи без изменений.
3. Проверить GitHub Pages, market CNAME, MX/TXT и остальные записи.
4. Переключить NS у регистратора на Cloudflare.
5. Убедиться, что основной сайт продолжает открываться по HTTPS.
6. Развернуть Worker.
7. Добавить routes из `wrangler.toml.example`.
8. Проверить:
   - `/api/market/health`
   - `/api/market/listings`
   - фотографии
   - подачу тестового объявления
   - Safari macOS / Safari iOS / Chrome macOS / Windows

## GitHub Actions

Workflow `.github/workflows/deploy-cloudflare-market-proxy.yml` использует секреты:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Секреты вводятся только в GitHub Settings → Secrets and variables → Actions.
Не передавать токены в чат и не хранить их в репозитории.
