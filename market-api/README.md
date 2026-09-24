# VARGI Market API

Backend Северного маркета ВАРГИ.

## Хранение

- заявки и фотографии: постоянный Railway volume `/data/submissions`;
- хеш пароля администратора: `/data/admin-auth.json`;
- удалённые объявления сначала попадают в статус `trash` и физически очищаются через 30 дней.

## Резервные копии

Сервис создаёт ежедневный архив volume-данных в приватный Railway Bucket и хранит последние 14 дней.
Ручной backup доступен из админ-панели.

Переменные:
- `BACKUP_S3_ENDPOINT`
- `BACKUP_S3_REGION`
- `BACKUP_S3_BUCKET`
- `BACKUP_S3_ACCESS_KEY_ID`
- `BACKUP_S3_SECRET_ACCESS_KEY`

## Администратор

- `ADMIN_SESSION_SECRET=[secret]`
- `ADMIN_RECOVERY_TOKEN=[secret]`
- `ADMIN_SETUP_TOKEN` используется только при первичной инициализации и после неё должен быть удалён.

## Прочее

- `SITE_ORIGIN=https://xn----7sbbfg4a6clj5k.xn--p1ai`

Секреты должны храниться только в Railway Variables и не попадать в GitHub.
