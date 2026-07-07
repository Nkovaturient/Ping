# Deadline Notify — zero-hosting Telegram alerts for Portal Pulse

Broadcasts alerts to a Telegram channel when an exam's form window is closing
soon, plus (once you have enough history) a note if the current hour has
historically been bad for that portal. No server — this piggybacks on
GitHub Actions, the same free infra Ping already uses.

## Setup (10 minutes)

1. **Create a bot**: message [@BotFather](https://t.me/BotFather) on Telegram,
   `/newbot`, follow the prompts. You'll get a token like `123456:ABC-DEF...`.

2. **Create a channel** (public or private) that students can join, and add
   your bot as an admin of it.

3. **Get the chat ID**: send any message in the channel, then visit
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser —
   look for `"chat":{"id": ...}` in the response. For public channels you can
   often just use `@yourchannelname` directly as the chat ID.

4. **Drop these files into your Ping repo** (or a new repo — either works):
   - `notify.py`
   - `deadlines.json`
   - `.github/workflows/notify.yml`

5. **Add repo secrets**: Settings → Secrets and variables → Actions →
   New repository secret:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

6. **Edit `notify.py`'s `load_ping_history()`** if your Ping repo stores
   historical ping data in a different shape/location than the one assumed
   at the top of the file — that's the only part that needs to match your
   actual data.

7. **Keep `deadlines.json` updated** as new exam notifications drop. This is
   manual for now — a natural next step once this is running smoothly is to
   scrape official notification pages automatically instead.

## What it does today vs. later

- **Today**: deadline-window reminders work immediately — no history needed.
- **In 3-4 weeks**, once Ping has enough samples per portal per hour, the
  `peak_hour_advisory()` function automatically starts adding real
  "this hour has historically been unreliable" warnings instead of staying
  silent on that part. Nothing to change — it activates itself once
  `MIN_SAMPLES_FOR_ADVISORY` is met.

## If you outgrow broadcast-only later

This sends one-way alerts to everyone in the channel. If you want per-user
subscriptions (e.g. "only alert me about SSC and IBPS"), that needs an
actual interactive bot with commands — see the `telegram-bot-skeleton/`
folder for a starting point, deployable to a free tier like Render or
Cloudflare Workers when you're ready for that.
