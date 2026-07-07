# Portal Pulse Bot — interactive skeleton (Phase 2)

Ship `../telegram-broadcast` first. Come here when you want per-user
subscriptions instead of one broadcast channel.

## Local run

```
npm install
TELEGRAM_BOT_TOKEN=your_token_here node index.js
```

## Deploying for real: Render (free web service tier)

Long-polling as written needs one process that stays alive, which is why this
piggybacks on Render's free tier rather than GitHub Actions like Ping/notify.py.

1. Push this folder (or the whole repo) to GitHub — Render deploys from a repo.
2. Render dashboard → **New** → **Web Service** → connect the repo.
3. Settings:
   - **Root directory**: `portal-uptime` (or wherever this `index.js` lives).
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Environment**: Node, instance type Free.
4. Add environment variables (Settings → Environment):
   - `TELEGRAM_BOT_TOKEN` — from @BotFather, same one used for the broadcast
     channel or a separate bot, your call.
   - `PING_REPO_OWNER` / `PING_REPO_NAME` / `PING_REPO_BRANCH` — only needed
     if this bot's repo differs from Ping's; defaults assume the same repo.
5. Deploy. Render's free tier spins the service down after ~15 minutes of no
   inbound HTTP traffic and back up on the next request — long-polling still
   works because Telegram's polling loop keeps the process busy, but expect
   an occasional cold-start delay of a few seconds on the very first message
   after idle time. If that's a problem, upgrade to a paid instance or switch
   to Cloudflare Workers with webhook mode instead of polling.
6. **Persistence caveat**: `subscriptions.json` and `fanout_state.json` are
   written to local disk. Render's free tier disk is ephemeral across
   deploys/restarts — a redeploy wipes subscriber data. For anything beyond
   a small pilot, swap `loadSubs`/`saveSubs` (and the fan-out state
   equivalents) for a Render persistent disk (paid) or an external store
   (e.g. a small KV/Postgres add-on) before relying on this in production.

## What's stubbed vs. real here

- `/start`, `/status`, `/subscribe`, `/unsubscribe`, `/mysubs` — fully working.
- `/start sub_<portal>` (deep link from Ping/Snapix's "Get Telegram alerts"
  widget) — fully working, auto-subscribes on first contact.
- `fetchLatestStatus()` / `fetchHistoryRows()` — read Ping's real
  `data/latest.json` + `data/uptime-YYYY-MM.csv` over HTTPS, same shape
  `index.html`'s dashboard already parses.
- The per-user scheduled fan-out ("DM me about SSC specifically when it's
  about to close") is implemented in `runFanout()`, reusing a JS port of
  notify.py's `peak_hour_advisory()` — kept in sync by comment, not by
  shared code, since the two run in different languages/processes.
- WhatsApp is not implemented — Telegram only for this phase, since WhatsApp
  requires a paid provider (Twilio/Meta Cloud API) unlike Telegram's free
  Bot API. Revisit if/when that budget exists.
