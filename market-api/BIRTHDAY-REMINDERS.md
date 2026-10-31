# Birthday reminders

The reminder list is `birthdays.json`: 18 verified names and day/month pairs,
with a public source for each. It intentionally omits birth years and the nine
members whose exact birthday was missing or unconfirmed on 2026-10-31.
Only add a date after it is verified. Do not import guessed January 1 dates or
the candidate date for Кирилл Гречников. The verified workbook is the research
record; this JSON is the operational subset.

## Schedule and destination

The existing `market-api` process checks once per minute. It sends reminders
at or shortly after **09:00 Europe/Moscow**, both one calendar day before a
birthday and on the birthday itself. It uses the existing Telegram bot and
the existing configured destination; the module contains no credentials or
chat identifiers. There is no separate paid scheduler or Railway service.

If the server starts after 09:00, it catches up for the current Moscow date.
It does not replay missed earlier dates. Pending work expires when its
scheduled local date passes. If a February 29 date is added later, reminders
will run only in leap years; the date is not silently moved to February 28 or
March 1. No current member in this operational list has that date.

## Integration

```js
import { createBirthdayReminders } from './birthday-reminders.js';

const birthdayReminders = await createBirthdayReminders({
  directory: path.join(DATA_ROOT, 'birthday-reminders'),
  birthdays: JSON.parse(await readFile(new URL('./birthdays.json', import.meta.url), 'utf8')),
  async send(reminder) {
    const cfg = await telegramConfig();
    if (!TELEGRAM_BOT_TOKEN || !cfg?.chatId) throw new Error('telegram_not_configured');
    return telegramApi('sendMessage', {
      chat_id: cfg.chatId,
      text: reminder.text,
      disable_web_page_preview: true
    });
  },
  log(event, key, details) {
    console.log(event, key || '', details?.messageId ? `message_id=${details.messageId}` : '');
  }
});

// When the HTTP server starts:
birthdayReminders.start();
// During graceful shutdown, before exiting:
await birthdayReminders.close();
```

Keep the existing 7-second Telegram HTTP timeout. `send` must return the
successful Telegram result, including a positive integer `message_id`.
Returning no receipt does not count as delivery. Copy `birthday-reminders.js`
and `birthdays.json` in the Dockerfile. Include `birthday-reminders/` in the
existing backup selection, preserving receipts when restoring the service.

## Persistence, retries and diagnosis

Each reminder has a stable key derived from person, birthday, scheduled
Moscow date and reminder type. A pending record is synced to the persistent
volume before a send, and a successful Telegram message identifier is synced
afterward. Normal repeated ticks and restarts skip recorded deliveries.
Retries use exponential backoff from one minute, capped at one hour, and
stop when the reminder's local day ends. Raw provider errors are not logged
because those errors can contain credentials.

`await birthdayReminders.status()` returns counts, current local date and
today's non-secret delivery receipts. Use this only behind the existing
admin authentication. `await birthdayReminders.tick()` processes the real
current date immediately; it is not a dry run. Do not expose a public trigger
endpoint, do not change the production clock for testing, and do not change
the destination to another chat for tests.

The supported deployment is the existing **one-replica service with one
persistent volume**. In-process ticks coalesce; an exclusive filesystem
lease prevents ordinary overlapping workers from sending concurrently.
A crashed worker's lease is reclaimed after five minutes, so a hard restart
can delay a catch-up send by up to five minutes. A graceful close releases
it as soon as the in-flight request completes. Do not horizontally scale
this worker without a shared transactional queue and explicit coordination.

Telegram does not provide an idempotency key for `sendMessage`. If Telegram
accepts a message but its response is lost, or the process dies before its
receipt is synced, a later retry can produce a duplicate. The module provides
persistent deduplication for acknowledged deliveries, not an impossible
exactly-once guarantee across the network.

## Tests

Run `node market-api/test/birthday-reminders.test.mjs` from the repository
root. The tests inject a fake clock and a fake sender: no real Telegram
messages or other network requests are sent. They cover the Moscow time
boundary, the two January 31 birthdays, New Year, leap dates, the verified
data subset, concurrent workers, persisted receipts, retries, crash leases,
expiration and shutdown.
