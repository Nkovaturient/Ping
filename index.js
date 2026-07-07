/**
 * Portal Pulse bot — interactive skeleton (Phase 2).
 *
 * Ship the broadcast version (../telegram-broadcast) first — it needs zero
 * hosting. Come back to this once you want per-user subscriptions like
 * "only alert me about SSC and IBPS" or a /status command people can
 * message on demand.
 *
 * Needs an always-on-ish process — deployed to Render's free web service
 * tier (see PULSE-BOT.md), long-polling as written here.
 *
 * Setup:
 *   npm install
 *   TELEGRAM_BOT_TOKEN=xxxx node index.js
 *
 * DATA SOURCE: this process has no repo checkout (unlike notify.py's
 * GitHub Action), so it always fetches Ping's real data — data/latest.json
 * and data/uptime-YYYY-MM.csv — over HTTPS from raw.githubusercontent.com.
 * Configure PING_REPO_OWNER/PING_REPO_NAME/PING_REPO_BRANCH if this bot
 * doesn't live in the same repo as Ping. The CSV parsing below mirrors
 * index.html's parseCSV() so both consumers stay in lockstep with Ping's
 * actual columns (timestamp_utc, portal_id, status_code, latency_ms, up).
 */

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN env var first.");
  process.exit(1);
}

const REPO_OWNER = process.env.PING_REPO_OWNER || "nkovaturient";
const REPO_NAME = process.env.PING_REPO_NAME || "Ping";
const REPO_BRANCH = process.env.PING_REPO_BRANCH || "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/data`;

const SUBS_FILE = path.join(__dirname, "subscriptions.json");
const DEADLINES_FILE = path.join(__dirname, "deadlines.json");
const FANOUT_STATE_FILE = path.join(__dirname, "fanout_state.json");

const KNOWN_PORTALS = [
  "ssc", "upsc", "neet", "jee", "ibps", "sbi", "rrb",
  "rbi", "uppsc", "upsssc", "bpsc", "mppsc", "rpsc", "mpsc", "tnpsc", "wbpsc"
];

// check_uptime.py runs every ~15 min (see .github/workflows/uptime-check.yml).
// Keep these thresholds in sync with notify.py's MIN_SAMPLES_FOR_ADVISORY /
// MIN_SAMPLES_PER_HOUR if you tune one, tune the other.
const MIN_SAMPLES_FOR_ADVISORY = 300;
const MIN_SAMPLES_PER_HOUR = 5;
const DANGER_WINDOW_DAYS = 3;
const FANOUT_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1h — runs often so we can catch tight windows

/**
 * Escalating alert cadence — quiet early, sharp near deadline.
 * Keep in sync with notify.py's alert_interval_hours().
 */
function alertIntervalHours(remainingDays) {
  if (remainingDays <= 0.5) return 2;   // final ~12 hours: every 2h
  if (remainingDays <= 1)   return 4;   // last day: every 4h
  if (remainingDays <= 2)   return 8;   // 1-2 days out: every 8h
  return 24;                            // 2-3 days out: once per day
}

function loadSubs() {
  if (!fs.existsSync(SUBS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}
function loadDeadlines() {
  if (!fs.existsSync(DEADLINES_FILE)) return [];
  return JSON.parse(fs.readFileSync(DEADLINES_FILE, "utf8"));
}
function loadFanoutState() {
  if (!fs.existsSync(FANOUT_STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(FANOUT_STATE_FILE, "utf8"));
}
function saveFanoutState(state) {
  fs.writeFileSync(FANOUT_STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.warn(`[warn] could not fetch ${url}: ${e.message}`);
    return null;
  }
}

// Same shape as index.html's parseCSV() — one row per check.
function parseCSV(text) {
  const lines = text.trim().split(/\r\n|\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    return row;
  });
}

function normalizeCsvRows(rawRows) {
  return rawRows.map((r) => ({
    portal: r.portal_id,
    timestamp: r.timestamp_utc,
    status: r.up === "1" || r.up === "true" || r.up === "True" ? "up" : "down",
    latencyMs: r.latency_ms ? parseFloat(r.latency_ms) : null,
  }));
}

function monthKey(date) {
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

// Full check-by-check history (current + previous month), for peak-hour scoring.
async function fetchHistoryRows() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [curText, prevText] = await Promise.all([
    fetchText(`${RAW_BASE}/uptime-${monthKey(now)}.csv`),
    fetchText(`${RAW_BASE}/uptime-${monthKey(prev)}.csv`),
  ]);
  const rows = [];
  if (prevText) rows.push(...parseCSV(prevText));
  if (curText) rows.push(...parseCSV(curText));
  return normalizeCsvRows(rows);
}

async function fetchLatestStatus() {
  const text = await fetchText(`${RAW_BASE}/latest.json`);
  const latest = text ? JSON.parse(text) : {};
  const latestByPortal = {};
  for (const [portalId, rec] of Object.entries(latest)) {
    latestByPortal[portalId] = {
      status: rec.up ? "up" : "down",
      latencyMs: rec.latency_ms,
      timestamp: rec.timestamp_utc,
    };
  }
  return latestByPortal;
}

function istHour(date) {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return Math.floor(((utcMinutes + 330) % 1440) / 60);
}

// Ported 1:1 from notify.py's peak_hour_advisory() — keep both in sync.
function peakHourAdvisory(history, portal, currentHour) {
  const samples = history.filter((h) => h.portal === portal);
  if (samples.length < MIN_SAMPLES_FOR_ADVISORY) return null;

  const byHour = {};
  samples.forEach((s) => {
    if (!s.timestamp) return;
    const ts = new Date(s.timestamp.endsWith("Z") ? s.timestamp : s.timestamp + "Z");
    (byHour[istHour(ts)] ||= []).push(s);
  });

  const thisHourSamples = byHour[currentHour] || [];
  if (thisHourSamples.length < MIN_SAMPLES_PER_HOUR) return null;

  const downRate = thisHourSamples.filter((s) => s.status !== "up").length / thisHourSamples.length;
  const latencies = thisHourSamples.filter((s) => s.latencyMs).map((s) => s.latencyMs);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const overallDownRate = samples.filter((s) => s.status !== "up").length / samples.length;

  if (downRate > overallDownRate * 1.5 && downRate > 0.15) {
    return `this hour has historically been unreliable (${Math.round(downRate * 100)}% failure rate vs ${Math.round(overallDownRate * 100)}% average)`;
  }
  if (avgLatency && avgLatency > 3000) {
    return `this hour has historically been slow (avg ${Math.round(avgLatency)}ms response)`;
  }
  return null;
}

function daysUntil(dateStr) {
  const iso = dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
  return (new Date(iso).getTime() - Date.now()) / 86400000;
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Shared by /subscribe and the /start sub_<portal> deep-link payload.
function subscribeUserToPortal(chatId, portal) {
  if (!KNOWN_PORTALS.includes(portal)) return false;
  const subs = loadSubs();
  const userId = String(chatId);
  subs[userId] = subs[userId] || [];
  if (!subs[userId].includes(portal)) subs[userId].push(portal);
  saveSubs(subs);
  return true;
}

// /start alone shows the help text. /start sub_ssc (from a
// t.me/<bot>?start=sub_ssc deep link on Ping/Snapix) subscribes immediately.
bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
  const payload = match[1];
  const subMatch = payload && /^sub_(\w+)$/.exec(payload);
  if (subMatch) {
    const portal = subMatch[1].toLowerCase();
    if (subscribeUserToPortal(msg.chat.id, portal)) {
      bot.sendMessage(
        msg.chat.id,
        `👋 Subscribed you to *${portal}* alerts. Use /mysubs to review, /unsubscribe ${portal} to stop.`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    bot.sendMessage(msg.chat.id, `Don't recognise "${portal}" — showing the full menu instead.`);
  }
  bot.sendMessage(
    msg.chat.id,
    "👋 Portal Pulse bot.\n\n" +
    "/status — current status of all tracked portals\n" +
    "/status ssc — status of one portal\n" +
    "/subscribe ssc — get alerted when SSC's window is closing soon\n" +
    "/unsubscribe ssc — stop those alerts\n" +
    "/mysubs — see what you're subscribed to"
  );
});

bot.onText(/\/status(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  try {
    const latest = await fetchLatestStatus();
    const portals = portalFilter ? [portalFilter] : Object.keys(latest);
    if (portals.length === 0) {
      bot.sendMessage(msg.chat.id, "No status data yet.");
      return;
    }
    const lines = portals.map((p) => {
      const s = latest[p];
      if (!s) return `${p}: no data`;
      const emoji = s.status === "up" ? "🟢" : "🔴";
      return `${emoji} ${p}: ${s.status} (${s.latencyMs ?? "—"}ms)`;
    });
    bot.sendMessage(msg.chat.id, lines.join("\n"));
  } catch (e) {
    bot.sendMessage(msg.chat.id, "Couldn't fetch status right now — try again shortly.");
  }
});

bot.onText(/\/subscribe\s+(\w+)/, (msg, match) => {
  const portal = match[1].toLowerCase();
  if (!subscribeUserToPortal(msg.chat.id, portal)) {
    bot.sendMessage(msg.chat.id, `Don't recognise "${portal}". Known: ${KNOWN_PORTALS.join(", ")}`);
    return;
  }
  bot.sendMessage(msg.chat.id, `Subscribed to ${portal}. Use /mysubs to review.`);
});

bot.onText(/\/unsubscribe\s+(\w+)/, (msg, match) => {
  const portal = match[1].toLowerCase();
  const subs = loadSubs();
  const userId = String(msg.chat.id);
  subs[userId] = (subs[userId] || []).filter((p) => p !== portal);
  saveSubs(subs);
  bot.sendMessage(msg.chat.id, `Unsubscribed from ${portal}.`);
});

bot.onText(/\/mysubs/, (msg) => {
  const subs = loadSubs();
  const mine = subs[String(msg.chat.id)] || [];
  bot.sendMessage(msg.chat.id, mine.length ? `You're subscribed to: ${mine.join(", ")}` : "No subscriptions yet.");
});

// Per-user fan-out: DMs each subscriber only about the portals they asked
// for, reusing the same deadline-window + peak-hour-advisory + escalating
// cadence logic as notify.py's broadcast, just targeted per chat_id.
// State stores ISO timestamps so we can gate on elapsed hours.
async function runFanout() {
  const subs = loadSubs();
  const subscribedUserIds = Object.keys(subs).filter((id) => subs[id].length > 0);
  if (subscribedUserIds.length === 0) return;

  const deadlines = loadDeadlines();
  if (deadlines.length === 0) return;

  const history = await fetchHistoryRows();
  const state = loadFanoutState();
  const now = new Date();
  const currentHour = istHour(now);

  for (const exam of deadlines) {
    const remaining = daysUntil(exam.deadline);
    if (remaining < 0 || remaining > DANGER_WINDOW_DAYS) continue;

    const advisory = peakHourAdvisory(history, exam.portal, currentHour);
    const lines = [
      `⏰ *${exam.displayName}* form window closes in *${remaining.toFixed(1)} days*.`,
      `Portal: ${exam.url}`,
      advisory
        ? `⚠️ Heads up: ${advisory}. Consider filling at a different time if you can.`
        : "No historical red flags for this hour — but don't wait for the last day.",
    ];
    const text = lines.join("\n");

    const requiredInterval = alertIntervalHours(remaining);

    for (const userId of subscribedUserIds) {
      if (!subs[userId].includes(exam.portal)) continue;
      const stateKey = `${userId}:${exam.portal}:${exam.deadline}`;
      const lastSentIso = state[stateKey];

      if (lastSentIso) {
        const hoursSince = (now - new Date(lastSentIso)) / (1000 * 60 * 60);
        if (hoursSince < requiredInterval) continue; // too soon per escalating cadence
      }

      try {
        await bot.sendMessage(userId, text, { parse_mode: "Markdown" });
        state[stateKey] = now.toISOString();
      } catch (e) {
        console.warn(`[warn] could not DM ${userId}: ${e.message}`);
      }
    }
  }

  saveFanoutState(state);
}

setInterval(() => {
  runFanout().catch((e) => console.error("[fanout] error:", e));
}, FANOUT_INTERVAL_MS);
runFanout().catch((e) => console.error("[fanout] initial run error:", e));

console.log("Bot running (long polling)...");
