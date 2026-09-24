# VARGI Market API

Backend Северного маркета ВАРГИ.

## Что хранится

- заявки и фотографии: постоянный Railway volume `/data/submissions`;
- хеш пароля администратора: `/data/admin-auth.json`.

## Railway variables

- `SITE_ORIGIN=https://xn----7sbbfg4a6clj5k.xn--p1ai`
- `ADMIN_SESSION_SECRET=[secret]`
- `ADMIN_SETUP_TOKEN=[secret]` — используется только при первичной настройке администратора.

Секреты должны храниться только в Railway Variables и не попадать в GitHub.
