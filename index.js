/**
 * Portal Pulse bot
 *
 * Setup:
 *   npm install
 *   TELEGRAM_BOT_TOKEN=xxxx SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node index.js
 *
 * DATA SOURCE: fetches Ping repo data over HTTPS from raw.githubusercontent.com
 * (latest.json, uptime CSV, deadlines.json, notifications.json).
 */

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const http = require("http");
const path = require("path");
const db = require("./db");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN env var first.");
  process.exit(1);
}

const REPO_OWNER = process.env.PING_REPO_OWNER || "nkovaturient";
const REPO_NAME = process.env.PING_REPO_NAME || "Ping";
const REPO_BRANCH = process.env.PING_REPO_BRANCH || "main";
const RAW_REPO_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;
const RAW_DATA_BASE = `${RAW_REPO_BASE}/data`;

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
const NOTIF_PAGE_SIZE = 8;

function portalName(id) {
  const p = PORTALS.find((x) => x.id === id);
  return p ? p.name : id.toUpperCase();
}

function subscriberMeta(msg) {
  return {
    username: msg.from?.username,
    first_name: msg.from?.first_name,
  };
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

async function pickerPortalIds(action, chatId) {
  if (action === "unsub") return db.getUserPortals(chatId);
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
    shortDescription: "Get portal alerts",
    summary: "Subscribe to new notifications, deadlines, and uptime alerts for a portal",
    args: [{ name: "portal", required: true, type: "portal" }],
    examples: ["/subscribe ssc", "/subscribe ibps"],
  },
  unsubscribe: {
    name: "unsubscribe",
    shortDescription: "Stop portal alerts",
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
  notifications: {
    name: "notifications",
    shortDescription: "Browse portal notices",
    summary: "Browse current vacancy/notification posts (paginated)",
    args: [{ name: "portal", required: false, type: "portal" }],
    examples: ["/notifications", "/notifications ssc"],
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
    "I track SSC, UPSC, NTA, IBPS, RRB & state portals — new vacancies, deadline reminders, and uptime changes.",
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

const MIN_SAMPLES_FOR_ADVISORY = 300;
const MIN_SAMPLES_PER_HOUR = 5;
const DANGER_WINDOW_DAYS = 3;
const DEADLINE_FANOUT_INTERVAL_MS = 1 * 60 * 60 * 1000;
const FAST_POLL_INTERVAL_MS = 5 * 60 * 1000;
const UPTIME_SLOW_MS = 5000;
const UPTIME_ALERT_COOLDOWN_HOURS = 0.5;
const TELEGRAM_SEND_DELAY_MS = 50;
const RATE_LIMIT_MS = 2500;

/**
 * Escalating alert cadence — quiet early, sharp near deadline.
 * Keep in sync with notify.py's alert_interval_hours().
 */
function alertIntervalHours(remainingDays) {
  if (remainingDays <= 0.5) return 2;
  if (remainingDays <= 1) return 4;
  if (remainingDays <= 2) return 8;
  return 24;
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

async function fetchJson(url) {
  const text = await fetchText(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn(`[warn] invalid JSON from ${url}: ${e.message}`);
    return null;
  }
}

async function fetchDeadlines() {
  const remote = await fetchJson(`${RAW_REPO_BASE}/deadlines.json`);
  if (remote) return remote;
  const local = path.join(__dirname, "deadlines.json");
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, "utf8"));
  return [];
}

async function fetchNotifications() {
  return (await fetchJson(`${RAW_DATA_BASE}/notifications.json`)) || [];
}

async function fetchNotificationState() {
  return (
    (await fetchJson(`${RAW_DATA_BASE}/notifications_state.json`)) || {
      seenIds: {},
      pendingIds: {},
      portalStatus: {},
    }
  );
}

function notifAlertKey(userId, portal, id) {
  return `${userId}:new:${portal}:${id}`;
}

function getConfirmedNotifications(notifications, notifState) {
  const seenIds = notifState.seenIds || {};
  const pendingIds = notifState.pendingIds || {};
  const confirmedIds = new Set(Object.keys(seenIds));
  for (const [id, count] of Object.entries(pendingIds)) {
    if (count >= 2) confirmedIds.add(id);
  }
  return notifications.filter((n) => confirmedIds.has(n.id));
}

function sortNotifications(items, notifState = {}) {
  const seenIds = notifState.seenIds || {};
  return [...items].sort((a, b) => {
    const sa = a.scrapedAt || seenIds[a.id] || a.postedAt || "";
    const sb = b.scrapedAt || seenIds[b.id] || b.postedAt || "";
    if (sa !== sb) return String(sb).localeCompare(String(sa));
    return (a.title || "").localeCompare(b.title || "");
  });
}

async function getUnsentForUser(userId, portal, items) {
  if (!items.length) return [];
  const keys = items.map((n) => notifAlertKey(userId, portal, n.id));
  const sent = await db.getSentStateKeys(keys);
  return items.filter((n) => !sent.has(notifAlertKey(userId, portal, n.id)));
}

function formatDigestMessage(portalCounts, heading = "📢 *New exam portal updates*") {
  const lines = [
    heading,
    "",
    ...portalCounts.map(
      ({ portal, count }) =>
        `• *${portalName(portal)}* — ${count} update${count === 1 ? "" : "s"}`
    ),
    "",
    "Tap a portal below to view details (newest first).",
    "Use *Block* to stop all alerts for a portal.",
  ];
  return lines.join("\n");
}

function truncateBtn(text, max = 40) {
  const t = String(text || "Open")
    .replace(/\s+/g, " ")
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function digestKeyboard(portalCounts, { includeBlock = true } = {}) {
  const rows = [];
  for (let i = 0; i < portalCounts.length; i += 2) {
    const row = [];
    const a = portalCounts[i];
    row.push({
      text: `${portalName(a.portal)} · ${a.count}`,
      callback_data: `n:v:${a.portal}:0`,
    });
    if (portalCounts[i + 1]) {
      const b = portalCounts[i + 1];
      row.push({
        text: `${portalName(b.portal)} · ${b.count}`,
        callback_data: `n:v:${b.portal}:0`,
      });
    }
    rows.push(row);
  }
  if (includeBlock) {
    for (let i = 0; i < portalCounts.length; i += 2) {
      const row = [];
      const a = portalCounts[i];
      row.push({ text: `Block ${portalName(a.portal)}`, callback_data: `n:b:${a.portal}` });
      if (portalCounts[i + 1]) {
        const b = portalCounts[i + 1];
        row.push({ text: `Block ${portalName(b.portal)}`, callback_data: `n:b:${b.portal}` });
      }
      rows.push(row);
    }
  }
  return { inline_keyboard: rows };
}

function removePortalFromKeyboard(markup, portal) {
  if (!markup?.inline_keyboard) return markup;
  const suffix = `:${portal}`;
  const rows = markup.inline_keyboard
    .map((row) =>
      row.filter((btn) => {
        const data = btn.callback_data || "";
        return !(data.endsWith(suffix) || data.includes(`${suffix}:`));
      })
    )
    .filter((row) => row.length > 0);
  return { inline_keyboard: rows };
}

function formatPortalPage(portal, items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / NOTIF_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * NOTIF_PAGE_SIZE;
  const slice = items.slice(start, start + NOTIF_PAGE_SIZE);
  const lines = [
    `📢 *${portalName(portal)}* — ${items.length} notice${items.length === 1 ? "" : "s"} (newest first)`,
    "",
  ];
  slice.forEach((n, i) => {
    const title = String(n.title || "Untitled").replace(/[*_`\[\]]/g, "");
    lines.push(`${start + i + 1}. ${title}`);
  });
  if (totalPages > 1) lines.push("", `_Page ${safePage + 1}/${totalPages}_`);
  lines.push("", "Tap a button below to open a notice.");
  return { text: lines.join("\n"), slice, totalPages, page: safePage };
}

function portalPageKeyboard(portal, page, totalPages, pageItems) {
  const rows = pageItems
    .filter((n) => n.url)
    .map((n, i) => [
      {
        text: `${page * NOTIF_PAGE_SIZE + i + 1}. ${truncateBtn(n.title, 36)}`,
        url: n.url,
      },
    ]);
  const nav = [];
  if (page > 0) nav.push({ text: "◀ Prev", callback_data: `n:v:${portal}:${page - 1}` });
  if (page + 1 < totalPages) nav.push({ text: "Next ▶", callback_data: `n:v:${portal}:${page + 1}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

async function showPortalNotifications(chatId, portal, page, messageId = null) {
  const [notifications, notifState] = await Promise.all([fetchNotifications(), fetchNotificationState()]);
  const items = sortNotifications(
    getConfirmedNotifications(notifications, notifState).filter((n) => n.portal === portal),
    notifState
  );
  const optsBase = { parse_mode: "Markdown", disable_web_page_preview: true };
  if (!items.length) {
    const empty = `No confirmed notifications for *${portalName(portal)}* yet.`;
    if (messageId) {
      await bot
        .editMessageText(empty, { chat_id: chatId, message_id: messageId, ...optsBase })
        .catch(() => bot.sendMessage(chatId, empty, optsBase));
    } else {
      await bot.sendMessage(chatId, empty, optsBase);
    }
    return;
  }
  const { text, slice, totalPages, page: safePage } = formatPortalPage(portal, items, page);
  const opts = { ...optsBase, reply_markup: portalPageKeyboard(portal, safePage, totalPages, slice) };
  if (messageId) {
    await bot
      .editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts })
      .catch(() => bot.sendMessage(chatId, text, opts));
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

async function sendPortalBacklogDigest(chatId, portal) {
  const [notifications, notifState] = await Promise.all([fetchNotifications(), fetchNotificationState()]);
  const confirmed = getConfirmedNotifications(notifications, notifState).filter((n) => n.portal === portal);
  const unsent = await getUnsentForUser(String(chatId), portal, confirmed);
  if (!unsent.length) return;
  const portalCounts = [{ portal, count: unsent.length }];
  const ok = await sendDm(chatId, formatDigestMessage(portalCounts), {
    reply_markup: digestKeyboard(portalCounts),
  });
  if (ok) {
    await db.setAlertSentBatch(unsent.map((n) => notifAlertKey(chatId, portal, n.id)));
  }
}

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

async function fetchHistoryRows() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [curText, prevText] = await Promise.all([
    fetchText(`${RAW_DATA_BASE}/uptime-${monthKey(now)}.csv`),
    fetchText(`${RAW_DATA_BASE}/uptime-${monthKey(prev)}.csv`),
  ]);
  const rows = [];
  if (prevText) rows.push(...parseCSV(prevText));
  if (curText) rows.push(...parseCSV(curText));
  return normalizeCsvRows(rows);
}

async function fetchLatestStatus() {
  const latest = (await fetchJson(`${RAW_DATA_BASE}/latest.json`)) || {};
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

const lastKnownUptime = {};
const userLastActionAt = new Map();
const userSlowDownUntil = new Map();

async function blockIfRateLimited(chatId) {
  const key = String(chatId);
  const now = Date.now();
  const last = userLastActionAt.get(key);
  if (last != null && now - last < RATE_LIMIT_MS) {
    if ((userSlowDownUntil.get(key) || 0) <= now) {
      userSlowDownUntil.set(key, now + RATE_LIMIT_MS);
      await bot.sendMessage(chatId, "⏳ Cool — Take a breath.").catch(() => {});
    }
    return true;
  }
  userLastActionAt.set(key, now);
  return false;
}

function onCmd(regex, handler) {
  bot.onText(regex, async (msg, match) => {
    if (await blockIfRateLimited(msg.chat.id)) return;
    return handler(msg, match);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendDm(chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...extra,
    });
    await sleep(TELEGRAM_SEND_DELAY_MS);
    return true;
  } catch (e) {
    console.warn(`[warn] could not DM ${chatId}: ${e.message}`);
    return false;
  }
}

async function sendPortalReply(chatId, { action, result }) {
  const opts = { parse_mode: "Markdown" };
  if (result.reason === "missing") {
    const portalIds = await pickerPortalIds(action, chatId);
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

async function doSubscribe(chatId, portal, meta = {}) {
  if (!KNOWN_PORTALS.includes(portal)) return;
  try {
    await db.subscribeUserToPortal(chatId, portal, meta);
    await bot.sendMessage(
      chatId,
      `✅ Subscribed to *${portalName(portal)}* alerts.\nYou'll get:\n• New vacancy/notification posts\n• Deadline reminders (within ${DANGER_WINDOW_DAYS} days)\n• Uptime down/slow alerts\n\n/mysubs — review · /unsubscribe ${portal} — stop · /notifications ${portal} — browse`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
    await sendPortalBacklogDigest(chatId, portal);
  } catch (e) {
    await bot.sendMessage(chatId, "⚠️ Subscriptions temporarily unavailable. Please try again shortly.");
  }
}

async function doUnsubscribe(chatId, portal) {
  try {
    const mine = await db.getUserPortals(chatId);
    if (!mine.includes(portal)) {
      await bot.sendMessage(
        chatId,
        `You're not subscribed to *${portalName(portal)}*.\n\nYour subs: ${mine.length ? mine.map((p) => portalName(p)).join(", ") : "none"}\n\n/mysubs — review · /subscribe ${portal} — add`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    await db.unsubscribeUserFromPortal(chatId, portal);
    await bot.sendMessage(
      chatId,
      `🔕 Unsubscribed from *${portalName(portal)}*.\n\n/subscribe ${portal} — re-enable alerts`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } catch (e) {
    await bot.sendMessage(chatId, "⚠️ Subscriptions temporarily unavailable. Please try again shortly.");
  }
}

async function doBlockFromDigest(chatId, portal) {
  try {
    const mine = await db.getUserPortals(chatId);
    if (!mine.includes(portal)) return false;
    await db.unsubscribeUserFromPortal(chatId, portal);
    return true;
  } catch (e) {
    console.warn(`[warn] digest block failed for ${chatId}/${portal}: ${e.message}`);
    return false;
  }
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

async function executeAction(action, chatId, portal, meta = {}) {
  switch (action) {
    case "sub":
      await doSubscribe(chatId, portal, meta);
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

bot.on("message", async (msg) => {
  if (!msg.text?.startsWith("/")) return;
  const token = msg.text.trim().split(/\s+/)[0];
  const cmd = token.split("@")[0].slice(1).toLowerCase();
  if (!cmd || COMMAND_NAMES.has(cmd)) return;
  if (await blockIfRateLimited(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id, unknownCommandReply(cmd), { parse_mode: "Markdown" });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (await blockIfRateLimited(chatId)) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  const data = query.data;

  if (data.startsWith("a:")) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const parts = data.split(":");
    const action = parts[1];
    const portal = parts.slice(2).join(":");
    const resolved = resolvePortal(portal);
    if (!resolved.ok) {
      await sendPortalReply(chatId, { action, result: resolved });
      return;
    }
    await executeAction(action, chatId, resolved.portal, subscriberMeta(query));
    return;
  }

  if (data.startsWith("p:")) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const [, action, pageStr] = data.split(":");
    const page = parseInt(pageStr, 10) || 0;
    const portalIds = await pickerPortalIds(action, chatId);
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
    return;
  }

  if (data.startsWith("n:v:")) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const parts = data.split(":");
    const portal = parts[2];
    const page = parseInt(parts[3], 10) || 0;
    const resolved = resolvePortal(portal);
    if (!resolved.ok) {
      await bot.sendMessage(chatId, `Unknown portal \`${portal}\`.`, { parse_mode: "Markdown" });
      return;
    }
    await showPortalNotifications(chatId, resolved.portal, page, query.message.message_id);
    return;
  }

  if (data.startsWith("n:b:")) {
    const portal = data.slice(4);
    const resolved = resolvePortal(portal);
    if (!resolved.ok) {
      await bot.answerCallbackQuery(query.id, { text: "Unknown portal" }).catch(() => {});
      return;
    }
    const blocked = await doBlockFromDigest(chatId, resolved.portal);
    if (blocked) {
      const updatedMarkup = removePortalFromKeyboard(query.message.reply_markup, resolved.portal);
      if (updatedMarkup.inline_keyboard.length > 0) {
        await bot
          .editMessageReplyMarkup(updatedMarkup, {
            chat_id: chatId,
            message_id: query.message.message_id,
          })
          .catch(() => {});
      } else {
        await bot
          .editMessageText(`${query.message.text}\n\n_All portals in this digest are now unsubscribed._`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          })
          .catch(() => {});
      }
    }
    await bot
      .answerCallbackQuery(query.id, {
        text: blocked ? `Unsubscribed from ${portalName(resolved.portal)}` : `${portalName(resolved.portal)} not active`,
      })
      .catch(() => {});
  }
});

onCmd(/\/start(?:\s+(\S+))?/, async (msg, match) => {
  const payload = match[1];
  const subMatch = payload && /^sub_(\w+)$/.exec(payload);
  if (subMatch) {
    const resolved = resolvePortal(subMatch[1]);
    if (resolved.ok) {
      await doSubscribe(msg.chat.id, resolved.portal, subscriberMeta(msg));
      return;
    }
    await sendPortalReply(msg.chat.id, { action: "sub", result: resolved });
    return;
  }
  try {
    await db.upsertSubscriber(msg.chat.id, subscriberMeta(msg));
  } catch (e) {
    /* non-fatal on welcome */
  }
  bot.sendMessage(msg.chat.id, WELCOME_TEXT, { parse_mode: "Markdown" });
});

onCmd(/\/status(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  if (portalFilter) {
    const resolved = resolvePortal(portalFilter);
    if (!resolved.ok) {
      await sendPortalReply(msg.chat.id, { action: "status", result: resolved });
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

onCmd(/\/subscribe\s+(\w+)/, async (msg, match) => {
  const resolved = resolvePortal(match[1]);
  if (!resolved.ok) {
    await sendPortalReply(msg.chat.id, { action: "sub", result: resolved });
    return;
  }
  await doSubscribe(msg.chat.id, resolved.portal, subscriberMeta(msg));
});

onCmd(/\/subscribe$/, async (msg) => {
  await sendPortalReply(msg.chat.id, { action: "sub", result: { ok: false, reason: "missing" } });
});

onCmd(/\/unsubscribe\s+(\w+)/, async (msg, match) => {
  const resolved = resolvePortal(match[1]);
  if (!resolved.ok) {
    await sendPortalReply(msg.chat.id, { action: "unsub", result: resolved });
    return;
  }
  await doUnsubscribe(msg.chat.id, resolved.portal);
});

onCmd(/\/unsubscribe$/, async (msg) => {
  await sendPortalReply(msg.chat.id, { action: "unsub", result: { ok: false, reason: "missing" } });
});

onCmd(/\/mysubs/, async (msg) => {
  try {
    const mine = await db.getUserPortals(msg.chat.id);
    if (mine.length === 0) {
      bot.sendMessage(msg.chat.id, "No subscriptions yet.\n\nUse /subscribe to pick a portal.", { parse_mode: "Markdown" });
      return;
    }
    bot.sendMessage(
      msg.chat.id,
      `📋 *Your subscriptions:*\n${mine.map((p) => `• ${portalName(p)}`).join("\n")}\n\n/unsubscribe — stop alerts · /subscribe — add back`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, "⚠️ Subscriptions temporarily unavailable. Please try again shortly.");
  }
});

onCmd(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
});

onCmd(/\/portals/, (msg) => {
  sendPortalsList(msg.chat.id);
});

onCmd(/\/notifications(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  if (portalFilter) {
    const resolved = resolvePortal(portalFilter);
    if (!resolved.ok) {
      await sendPortalReply(msg.chat.id, { action: "status", result: resolved });
      return;
    }
    await showPortalNotifications(msg.chat.id, resolved.portal, 0);
    return;
  }
  try {
    const [notifications, notifState, mine] = await Promise.all([
      fetchNotifications(),
      fetchNotificationState(),
      db.getUserPortals(msg.chat.id),
    ]);
    const confirmed = getConfirmedNotifications(notifications, notifState);
    const preferred = mine.length ? mine : KNOWN_PORTALS;
    const counts = {};
    for (const n of confirmed) {
      if (!preferred.includes(n.portal)) continue;
      counts[n.portal] = (counts[n.portal] || 0) + 1;
    }
    const portalCounts = Object.entries(counts)
      .map(([portal, count]) => ({ portal, count }))
      .sort((a, b) => b.count - a.count || a.portal.localeCompare(b.portal));
    if (!portalCounts.length) {
      await bot.sendMessage(
        msg.chat.id,
        mine.length
          ? "No confirmed notifications for your subscriptions yet.\n\nTry /notifications ssc to browse a portal."
          : "No notifications yet. Subscribe first with /subscribe, or try /notifications ssc.",
        { parse_mode: "Markdown", disable_web_page_preview: true }
      );
      return;
    }
    await bot.sendMessage(msg.chat.id, formatDigestMessage(portalCounts, "📢 *Exam portal notifications*"), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: digestKeyboard(portalCounts),
    });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, "Couldn't load notifications right now — try again shortly.");
  }
});

onCmd(/\/history(?:\s+(\w+))?/, async (msg, match) => {
  const portalFilter = match[1]?.toLowerCase();
  try {
    const [history, latest] = await Promise.all([fetchHistoryRows(), fetchLatestStatus()]);

    if (portalFilter) {
      const resolved = resolvePortal(portalFilter);
      if (!resolved.ok) {
        await sendPortalReply(msg.chat.id, { action: "history", result: resolved });
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

onCmd(/\/peak(?:\s+(\w+))?/, async (msg, match) => {
  const portalArg = match[1]?.toLowerCase();
  if (!portalArg) {
    await sendPortalReply(msg.chat.id, { action: "peak", result: { ok: false, reason: "missing" } });
    return;
  }
  const resolved = resolvePortal(portalArg);
  if (!resolved.ok) {
    await sendPortalReply(msg.chat.id, { action: "peak", result: resolved });
    return;
  }
  await doPeak(msg.chat.id, resolved.portal);
});

async function runDeadlineFanout() {
  const subs = await db.getAllSubsMap();
  const subscribedUserIds = Object.keys(subs).filter((id) => subs[id].length > 0);
  if (subscribedUserIds.length === 0) return;

  const deadlines = await fetchDeadlines();
  if (deadlines.length === 0) return;

  const history = await fetchHistoryRows();
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
      const stateKey = `${userId}:deadline:${exam.portal}:${exam.deadline}`;
      const lastSentIso = await db.getAlertSentAt(stateKey);
      if (lastSentIso) {
        const hoursSince = (now - new Date(lastSentIso)) / (1000 * 60 * 60);
        if (hoursSince < requiredInterval) continue;
      }
      if (await sendDm(userId, text)) {
        await db.setAlertSent(stateKey);
      }
    }
  }
}

async function runNotificationFanout() {
  const [notifications, notifState, subs] = await Promise.all([
    fetchNotifications(),
    fetchNotificationState(),
    db.getAllSubsMap(),
  ]);
  if (!notifications.length) return;

  const confirmed = getConfirmedNotifications(notifications, notifState);
  if (!confirmed.length) return;

  const byPortal = {};
  for (const n of confirmed) {
    (byPortal[n.portal] ||= []).push(n);
  }

  for (const [userId, portals] of Object.entries(subs)) {
    const portalCounts = [];
    const keysToMark = [];
    for (const portal of portals) {
      const items = byPortal[portal] || [];
      if (!items.length) continue;
      const unsent = await getUnsentForUser(userId, portal, items);
      if (!unsent.length) continue;
      portalCounts.push({ portal, count: unsent.length });
      for (const n of unsent) keysToMark.push(notifAlertKey(userId, portal, n.id));
    }
    if (!portalCounts.length) continue;
    portalCounts.sort((a, b) => b.count - a.count || a.portal.localeCompare(b.portal));
    if (await sendDm(userId, formatDigestMessage(portalCounts), { reply_markup: digestKeyboard(portalCounts) })) {
      await db.setAlertSentBatch(keysToMark);
    }
  }
}

async function runUptimeFanout() {
  const latest = await fetchLatestStatus();
  const subs = await db.getAllSubsMap();

  for (const [portalId, rec] of Object.entries(latest)) {
    const prev = lastKnownUptime[portalId];
    const slowNow = rec.status === "up" && rec.latencyMs && rec.latencyMs > UPTIME_SLOW_MS;

    let alertType = null;
    if (prev) {
      if (prev.status === "up" && rec.status === "down") alertType = "down";
      else if (prev.status === "down" && rec.status === "up") alertType = "up";
      else if (slowNow && !prev.slow) alertType = "slow";
    }

    lastKnownUptime[portalId] = { status: rec.status, slow: !!slowNow };

    if (!alertType) continue;

    const subscribers = await db.getSubscribersForPortal(portalId);
    if (subscribers.length === 0) continue;

    let text;
    switch (alertType) {
      case "down":
        text = `🔴 *${portalName(portalId)}* is down right now.\nLast check: ${rec.latencyMs ?? "—"}ms`;
        break;
      case "up":
        text = `🟢 *${portalName(portalId)}* is back up.\nLatency: ${rec.latencyMs ?? "—"}ms`;
        break;
      case "slow":
        text = `🐢 *${portalName(portalId)}* is very slow right now (${rec.latencyMs}ms).\nConsider trying again later.`;
        break;
      default: {
        const _exhaustive = alertType;
        continue;
      }
    }

    for (const userId of subscribers) {
      const stateKey = `${userId}:uptime:${portalId}:${alertType}`;
      if (await db.wasAlertSentWithin(stateKey, UPTIME_ALERT_COOLDOWN_HOURS)) continue;
      if (await sendDm(userId, text)) {
        await db.setAlertSent(stateKey);
      }
    }
  }
}

async function runFastPoll() {
  await runNotificationFanout();
  await runUptimeFanout();
}

setInterval(() => {
  runDeadlineFanout().catch((e) => console.error("[deadline-fanout] error:", e));
}, DEADLINE_FANOUT_INTERVAL_MS);

setInterval(() => {
  runFastPoll().catch((e) => console.error("[fast-poll] error:", e));
}, FAST_POLL_INTERVAL_MS);

runDeadlineFanout().catch((e) => console.error("[deadline-fanout] initial error:", e));
runFastPoll().catch((e) => console.error("[fast-poll] initial error:", e));

console.log("Bot running (long polling + Supabase)...");

http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 3000);
