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
const http = require("http");
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
const PORTALS_FILE = path.join(__dirname, "config", "portals.json");

function loadPortals() {
  if (!fs.existsSync(PORTALS_FILE)) {
    console.warn("[warn] config/portals.json missing — using empty portal list");
    return [];
  }
  return JSON.parse(fs.readFileSync(PORTALS_FILE, "utf8")).map((p) => ({ id: p.id, name: p.name }));
}

const PORTALS = loadPortals();
const KNOWN_PORTALS = PORTALS.map((p) => p.id);
const PICKER_PAGE_SIZE = 8;

function portalName(id) {
  const p = PORTALS.find((x) => x.id === id);
  return p ? p.name : id.toUpperCase();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function fuzzyPortalMatch(input) {
  const q = input.toLowerCase();
  if (KNOWN_PORTALS.includes(q)) return q;
  const prefixHits = KNOWN_PORTALS.filter((id) => id.startsWith(q) || q.startsWith(id));
  if (prefixHits.length === 1) return prefixHits[0];
  const maxDist = q.length < 4 ? 1 : 2;
  let best = null;
  let bestDist = Infinity;
  for (const id of KNOWN_PORTALS) {
    const dist = levenshtein(q, id);
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return bestDist <= maxDist ? best : null;
}

function resolvePortal(input) {
  if (!input) return { ok: false, reason: "missing" };
  const id = input.toLowerCase();
  if (KNOWN_PORTALS.includes(id)) return { ok: true, portal: id };
  const suggestion = fuzzyPortalMatch(id);
  if (suggestion) return { ok: false, reason: "fuzzy", portal: id, suggestion };
  return { ok: false, reason: "unknown", portal: id };
}

function actionLabel(action) {
  switch (action) {
    case "sub": return "Subscribe";
    case "unsub": return "Unsubscribe";
    case "peak": return "Peak";
    case "status": return "Status";
    case "history": return "History";
    default: {
      const _exhaustive = action;
      return _exhaustive;
    }
  }
}

function actionExample(action) {
  switch (action) {
    case "sub": return "/subscribe ssc";
    case "unsub": return "/unsubscribe ssc";
    case "peak": return "/peak ssc";
    case "status": return "/status ssc";
    case "history": return "/history ssc";
    default: {
      const _exhaustive = action;
      return `/unknown ${_exhaustive}`;
    }
  }
}

function pickerPromptText(action) {
  switch (action) {
    case "sub": return "Pick a portal to subscribe:";
    case "unsub": return "Pick a subscription to remove:";
    case "peak": return "Pick a portal for peak-hour analysis:";
    default: {
      const _exhaustive = action;
      return `Pick a portal (${_exhaustive}):`;
    }
  }
}

function pickerPortalIds(action, chatId) {
  if (action === "unsub") return loadSubs()[String(chatId)] || [];
  return KNOWN_PORTALS;
}

function portalGridKeyboard(action, page, portalIds) {
  const total = portalIds.length;
  const start = page * PICKER_PAGE_SIZE;
  const slice = portalIds.slice(start, start + PICKER_PAGE_SIZE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: portalName(slice[i]), callback_data: `a:${action}:${slice[i]}` }];
    if (slice[i + 1]) row.push({ text: portalName(slice[i + 1]), callback_data: `a:${action}:${slice[i + 1]}` });
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: "◀ Prev", callback_data: `p:${action}:${page - 1}` });
  if (start + PICKER_PAGE_SIZE < total) nav.push({ text: "Next ▶", callback_data: `p:${action}:${page + 1}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

function fuzzyConfirmKeyboard(action, portalId) {
  const pickerAction = action === "unsub" ? "sub" : action;
  return {
    inline_keyboard: [
      [{ text: `${actionLabel(action)} ${portalName(portalId)}`, callback_data: `a:${action}:${portalId}` }],
      [{ text: "See all portals", callback_data: `p:${pickerAction}:0` }],
    ],
  };
}

function usageFooterKeyboard(action) {
  const pickerAction = action === "unsub" ? "sub" : action;
  return { inline_keyboard: [[{ text: "See all portals", callback_data: `p:${pickerAction}:0` }]] };
}

/**
 * Single source of truth for bot commands — drives /help, /start, BotFather
 * menu, usage prompts, and the unknown-command fallback.
 */
const COMMAND_SPECS = {
  start: {
    name: "start",
    shortDescription: "Welcome and command menu",
    summary: "Welcome message with full command list",
    args: [{ name: "payload", required: false, hint: "Deep link, e.g. sub_ssc" }],
    examples: ["/start", "/start sub_ssc"],
  },
  status: {
    name: "status",
    shortDescription: "Live portal status",
    summary: "Live status of monitored portals",
    args: [{ name: "portal", required: false, type: "portal" }],
    examples: ["/status", "/status ssc"],
  },
  subscribe: {
    name: "subscribe",
    shortDescription: "Get deadline alerts",
    summary: "Subscribe to deadline alerts for a portal",
    args: [{ name: "portal", required: true, type: "portal" }],
    examples: ["/subscribe ssc", "/subscribe ibps"],
  },
  unsubscribe: {
    name: "unsubscribe",
    shortDescription: "Stop deadline alerts",
    summary: "Unsubscribe from a portal's alerts",
    args: [{ name: "portal", required: true, type: "portal" }],
    examples: ["/unsubscribe ssc"],
  },
  mysubs: {
    name: "mysubs",
    shortDescription: "Your active subscriptions",
    summary: "List portals you're subscribed to",
    args: [],
    examples: ["/mysubs"],
  },
  history: {
    name: "history",
    shortDescription: "24h uptime trends",
    summary: "24h uptime summary or one portal's trend",
    args: [{ name: "portal", required: false, type: "portal" }],
    examples: ["/history", "/history ssc"],
  },
  peak: {
    name: "peak",
    shortDescription: "Best/worst hours (IST)",
    summary: "Historically best and worst hours to use a portal",
    args: [{ name: "portal", required: true, type: "portal" }],
    examples: ["/peak ssc", "/peak ibps"],
  },
  portals: {
    name: "portals",
    shortDescription: "All monitored portals",
    summary: "List all portal IDs with quick command links",
    args: [],
    examples: ["/portals"],
  },
  help: {
    name: "help",
    shortDescription: "Full command reference",
    summary: "Show this command reference",
    args: [],
    examples: ["/help"],
  },
};

const COMMAND_NAMES = new Set(Object.values(COMMAND_SPECS).map((c) => c.name));

function unknownCommandReply(rawCmd) {
  const known = Object.values(COMMAND_SPECS)
    .filter((c) => c.name !== "start")
    .map((c) => `/${c.name} — ${c.shortDescription}`)
    .join("\n");
  return [
    `Unknown command \`/${rawCmd}\`.`,
    "",
    "*Available commands:*",
    known,
    "",
    "Full reference: /help",
  ].join("\n");
}

function buildWelcomeText() {
  const cmds = Object.values(COMMAND_SPECS)
    .filter((c) => c.name !== "start" && c.name !== "help")
    .map((c) => {
      const example = c.examples.find((e) => e.includes(" ")) || c.examples[0];
      return `${example} — ${c.summary.charAt(0).toLowerCase()}${c.summary.slice(1)}`;
    });
  return [
    "👋 *Welcome to PortalPulseBot* ⚡",
    "",
    "Your exam lifeline. 🎯",
    "I track live status of SSC, UPSC, NTA, IBPS, RRB & major state portals and send timely alerts.",
    "",
    "*Commands:*",
    ...cmds,
    "/help — full command reference",
  ].join("\n");
}

function buildHelpText() {
  const lines = ["*PortalPulseBot — Command Reference*", ""];
  Object.values(COMMAND_SPECS).forEach((spec) => {
    if (spec.name === "start") return;
    spec.examples.forEach((ex, i) => {
      lines.push(`${ex} — ${i === 0 ? spec.summary : "variant"}`);
    });
  });
  lines.push("", "*Portal IDs:*", KNOWN_PORTALS.join(", "));
  return lines.join("\n");
}

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

function formatHour12(h) {
  return `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`;
}

function recentUptimeStats(history, portal, windowHours = 24) {
  const cutoff = Date.now() - windowHours * 3_600_000;
  const rows = history.filter((r) => {
    if (r.portal !== portal || !r.timestamp) return false;
    return new Date(r.timestamp.endsWith("Z") ? r.timestamp : r.timestamp + "Z").getTime() >= cutoff;
  });
  if (rows.length === 0) return null;
  const upCount = rows.filter((r) => r.status === "up").length;
  const lats = rows.filter((r) => r.latencyMs).map((r) => r.latencyMs);
  const avgLat = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
  return { upPct: Math.round((upCount / rows.length) * 100), avgLat, count: rows.length };
}

function portalHourBreakdown(history, portal) {
  const samples = history.filter((h) => h.portal === portal);
  if (samples.length < 10) return null;
  const byHour = {};
  samples.forEach((s) => {
    if (!s.timestamp) return;
    const ts = new Date(s.timestamp.endsWith("Z") ? s.timestamp : s.timestamp + "Z");
    (byHour[istHour(ts)] ||= []).push(s);
  });
  return Object.entries(byHour)
    .filter(([, rows]) => rows.length >= 2)
    .map(([h, rows]) => {
      const downCount = rows.filter((r) => r.status !== "up").length;
      const lats = rows.filter((r) => r.latencyMs).map((r) => r.latencyMs);
      return {
        hour: +h,
        downRate: downCount / rows.length,
        avgLat: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
        count: rows.length,
      };
    })
    .sort((a, b) => a.downRate - b.downRate || (a.avgLat || 0) - (b.avgLat || 0));
}

const WELCOME_TEXT = buildWelcomeText();
const HELP_TEXT = buildHelpText();

const bot = new TelegramBot(TOKEN, { polling: true });

function sendPortalReply(chatId, { action, result }) {
  const opts = { parse_mode: "Markdown" };
  if (result.reason === "missing") {
    const portalIds = pickerPortalIds(action, chatId);
    if (action === "unsub" && portalIds.length === 0) {
      bot.sendMessage(chatId, "You have no active subscriptions.\n\nUse /subscribe to get started.", opts);
      return;
    }
    bot.sendMessage(chatId, pickerPromptText(action), {
      ...opts,
      reply_markup: portalGridKeyboard(action, 0, portalIds),
    });
    return;
  }
  if (result.reason === "fuzzy") {
    bot.sendMessage(
      chatId,
      `Did you mean *${portalName(result.suggestion)}*? (you typed \`${result.portal}\`)`,
      { ...opts, reply_markup: fuzzyConfirmKeyboard(action, result.suggestion) }
    );
    return;
  }
  if (result.reason === "unknown") {
    bot.sendMessage(
      chatId,
      `❌ Unknown portal *"${result.portal}"*.\n\nExample: \`${actionExample(action)}\``,
      { ...opts, reply_markup: usageFooterKeyboard(action) }
    );
  }
}

function sendPortalsList(chatId) {
  const lines = [
    "📋 *Monitored portals*",
    "",
    ...KNOWN_PORTALS.map((p) => `• *${portalName(p)}* — /subscribe ${p} · /peak ${p}`),
    "",
    "Use portal ID with commands, e.g. /status ssc",
  ];
  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
}

function subscribeUserToPortal(chatId, portal) {
  if (!KNOWN_PORTALS.includes(portal)) return false;
  const subs = loadSubs();
  const userId = String(chatId);
  subs[userId] = subs[userId] || [];
  if (!subs[userId].includes(portal)) subs[userId].push(portal);
  saveSubs(subs);
  return true;
}

async function doSubscribe(chatId, portal) {
  subscribeUserToPortal(chatId, portal);
  await bot.sendMessage(
    chatId,
    `✅ Subscribed to *${portalName(portal)}* alerts.\nYou'll be notified when its form deadline is within ${DANGER_WINDOW_DAYS} days.\n\n/mysubs — review · /unsubscribe ${portal} — stop`,
    { parse_mode: "Markdown" }
  );
}

async function doUnsubscribe(chatId, portal) {
  const subs = loadSubs();
  const userId = String(chatId);
  const mine = subs[userId] || [];
  if (!mine.includes(portal)) {
    await bot.sendMessage(
      chatId,
      `You're not subscribed to *${portalName(portal)}*.\n\nYour subs: ${mine.length ? mine.map((p) => portalName(p)).join(", ") : "none"}\n\n/mysubs — review · /subscribe ${portal} — add`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  subs[userId] = mine.filter((p) => p !== portal);
  saveSubs(subs);
  await bot.sendMessage(chatId, `🔕 Unsubscribed from *${portalName(portal)}*.`, { parse_mode: "Markdown" });
}

async function doStatus(chatId, portal) {
  try {
    const latest = await fetchLatestStatus();
    const s = latest[portal];
    if (!s) {
      await bot.sendMessage(chatId, `${portal}: no data`);
      return;
    }
    const emoji = s.status === "up" ? "🟢" : "🔴";
    await bot.sendMessage(chatId, `${emoji} ${portal}: ${s.status} (${s.latencyMs ?? "—"}ms)`);
  } catch (e) {
    await bot.sendMessage(chatId, "Couldn't fetch status right now — try again shortly.");
  }
}

async function doHistory(chatId, portal) {
  try {
    const [history, latest] = await Promise.all([fetchHistoryRows(), fetchLatestStatus()]);
    const stats = recentUptimeStats(history, portal);
    const live = latest[portal];
    const liveStr = live
      ? `${live.status === "up" ? "🟢" : "🔴"} *Currently:* ${live.status} (${live.latencyMs ?? "—"}ms)`
      : "⚪ No live data";
    if (!stats) {
      await bot.sendMessage(chatId, `${liveStr}\n\nNo 24h history for ${portalName(portal)} yet.`, { parse_mode: "Markdown" });
      return;
    }
    const filled = Math.round(stats.upPct / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    await bot.sendMessage(
      chatId,
      [
        `📈 *${portalName(portal)} — last 24h*`,
        liveStr,
        `Uptime: \`${bar}\` ${stats.upPct}%`,
        `Avg latency: ${stats.avgLat ?? "—"}ms`,
        `Checks in window: ${stats.count}`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, "Couldn't fetch data right now — try again shortly.");
  }
}

async function doPeak(chatId, portal) {
  try {
    const history = await fetchHistoryRows();
    const breakdown = portalHourBreakdown(history, portal);
    if (!breakdown || breakdown.length === 0) {
      await bot.sendMessage(
        chatId,
        `Not enough history for ${portalName(portal)} yet — check back in a few days once the scheduler has run.`
      );
      return;
    }
    const fmt = (h) =>
      `${formatHour12(h.hour)} IST — ${Math.round(h.downRate * 100)}% down, avg ${h.avgLat ?? "—"}ms (${h.count} checks)`;
    const best = breakdown.slice(0, 3);
    const worst = [...breakdown].reverse().slice(0, 3);
    await bot.sendMessage(
      chatId,
      [
        `📊 *${portalName(portal)} — peak-hour analysis (IST)*`,
        "",
        "✅ *Best hours to fill forms:*",
        ...best.map((h) => `  ${fmt(h)}`),
        "",
        "🔴 *Worst hours to avoid:*",
        ...worst.map((h) => `  ${fmt(h)}`),
        "",
        `_Based on ${history.filter((r) => r.portal === portal).length} total checks._`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, "Couldn't fetch history right now — try again shortly.");
  }
}

async function executeAction(action, chatId, portal) {
  switch (action) {
    case "sub":
      await doSubscribe(chatId, portal);
      break;
    case "unsub":
      await doUnsubscribe(chatId, portal);
      break;
    case "peak":
      await doPeak(chatId, portal);
      break;
    case "status":
      await doStatus(chatId, portal);
      break;
    case "history":
      await doHistory(chatId, portal);
      break;
    default: {
      const _exhaustive = action;
      console.warn("[warn] unknown action:", _exhaustive);
    }
  }
}

bot.setMyCommands(
  Object.values(COMMAND_SPECS)
    .filter((c) => c.name !== "start")
    .map((c) => ({ command: c.name, description: c.shortDescription }))
).catch((e) => console.warn("[warn] setMyCommands failed:", e.message));

bot.on("message", (msg) => {
  if (!msg.text?.startsWith("/")) return;
  const token = msg.text.trim().split(/\s+/)[0];
  const cmd = token.split("@")[0].slice(1).toLowerCase();
  if (!cmd || COMMAND_NAMES.has(cmd)) return;
  bot.sendMessage(msg.chat.id, unknownCommandReply(cmd), { parse_mode: "Markdown" });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data.startsWith("a:")) {
    const parts = data.split(":");
    const action = parts[1];
    const portal = parts.slice(2).join(":");
    const resolved = resolvePortal(portal);
    if (!resolved.ok) {
      sendPortalReply(chatId, { action, result: resolved });
      return;
    }
    await executeAction(action, chatId, resolved.portal);
    return;
  }

  if (data.startsWith("p:")) {
    const [, action, pageStr] = data.split(":");
    const page = parseInt(pageStr, 10) || 0;
    const portalIds = pickerPortalIds(action, chatId);
    if (portalIds.length === 0) {
      bot.sendMessage(chatId, "You have no active subscriptions.\n\nUse /subscribe to get started.", { parse_mode: "Markdown" });
      return;
    }
    const keyboard = portalGridKeyboard(action, page, portalIds);
    await bot
      .editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: query.message.message_id })
      .catch(() => {
        bot.sendMessage(chatId, pickerPromptText(action), {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      });
  }
});

// /start alone → welcome. /start sub_ssc (deep-link from Ping/Snapix) → auto-subscribe.
bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
  const payload = match[1];
  const subMatch = payload && /^sub_(\w+)$/.exec(payload);
  if (subMatch) {
    const resolved = resolvePortal(subMatch[1]);
    if (resolved.ok) {
      doSubscribe(msg.chat.id, resolved.portal);
      return;
    }
    sendPortalReply(msg.chat.id, { action: "sub", result: resolved });
    return;
  }
  bot.sendMessage(msg.chat.id, WELCOME_TEXT, { parse_mode: "Markdown" });
});

bot.onText(/\/status(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  if (portalFilter) {
    const resolved = resolvePortal(portalFilter);
    if (!resolved.ok) {
      sendPortalReply(msg.chat.id, { action: "status", result: resolved });
      return;
    }
    await doStatus(msg.chat.id, resolved.portal);
    return;
  }
  try {
    const latest = await fetchLatestStatus();
    const portals = Object.keys(latest);
    if (portals.length === 0) {
      bot.sendMessage(msg.chat.id, "No status data yet — check back shortly after the first uptime run.");
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
  const resolved = resolvePortal(match[1]);
  if (!resolved.ok) {
    sendPortalReply(msg.chat.id, { action: "sub", result: resolved });
    return;
  }
  doSubscribe(msg.chat.id, resolved.portal);
});

bot.onText(/\/subscribe$/, (msg) => {
  sendPortalReply(msg.chat.id, { action: "sub", result: { ok: false, reason: "missing" } });
});

bot.onText(/\/unsubscribe\s+(\w+)/, (msg, match) => {
  const resolved = resolvePortal(match[1]);
  if (!resolved.ok) {
    sendPortalReply(msg.chat.id, { action: "unsub", result: resolved });
    return;
  }
  doUnsubscribe(msg.chat.id, resolved.portal);
});

bot.onText(/\/unsubscribe$/, (msg) => {
  sendPortalReply(msg.chat.id, { action: "unsub", result: { ok: false, reason: "missing" } });
});

bot.onText(/\/mysubs/, (msg) => {
  const subs = loadSubs();
  const mine = subs[String(msg.chat.id)] || [];
  if (mine.length === 0) {
    bot.sendMessage(msg.chat.id, "No subscriptions yet.\n\nUse /subscribe to pick a portal.", { parse_mode: "Markdown" });
    return;
  }
  bot.sendMessage(
    msg.chat.id,
    `📋 *Your subscriptions:*\n${mine.map((p) => `• ${portalName(p)}`).join("\n")}\n\n/unsubscribe — remove one`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
});

bot.onText(/\/portals/, (msg) => {
  sendPortalsList(msg.chat.id);
});

bot.onText(/\/history(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  try {
    const [history, latest] = await Promise.all([fetchHistoryRows(), fetchLatestStatus()]);

    if (portalFilter) {
      const resolved = resolvePortal(portalFilter);
      if (!resolved.ok) {
        sendPortalReply(msg.chat.id, { action: "history", result: resolved });
        return;
      }
      await doHistory(msg.chat.id, resolved.portal);
      return;
    }
    const portals = KNOWN_PORTALS.filter((p) => latest[p]);
    if (portals.length === 0) {
      bot.sendMessage(msg.chat.id, "No data yet — check back shortly after the first run.");
      return;
    }
    const lines = ["📈 *24h uptime summary*", ""];
    portals.forEach((p) => {
      const stats = recentUptimeStats(history, p);
      const live = latest[p];
      const emoji = live ? (live.status === "up" ? "🟢" : "🔴") : "⚪";
      lines.push(`${emoji} *${portalName(p)}* — ${stats ? `${stats.upPct}%` : "—"} up · ${stats?.avgLat ? `${stats.avgLat}ms` : "—"}`);
    });
    lines.push("", "Tap /history ssc for a portal's detail.");
    bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, "Couldn't fetch data right now — try again shortly.");
  }
});

bot.onText(/\/peak(?:\s+(\w+))?/, async (msg, match) => {
  const portalArg = match[1]?.toLowerCase();
  if (!portalArg) {
    sendPortalReply(msg.chat.id, { action: "peak", result: { ok: false, reason: "missing" } });
    return;
  }
  const resolved = resolvePortal(portalArg);
  if (!resolved.ok) {
    sendPortalReply(msg.chat.id, { action: "peak", result: resolved });
    return;
  }
  await doPeak(msg.chat.id, resolved.portal);
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

http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 3000);
