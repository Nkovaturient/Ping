const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function dbError(context, error) {
  console.error(`[db] ${context}:`, error.message);
  throw new Error("subscriptions temporarily unavailable");
}

async function upsertSubscriber(chatId, meta = {}) {
  const { error } = await supabase.from("subscribers").upsert(
    {
      chat_id: chatId,
      username: meta.username || null,
      first_name: meta.first_name || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" }
  );
  if (error) dbError("upsertSubscriber", error);
}

async function getUserPortals(chatId) {
  const { data, error } = await supabase
    .from("subscription_portals")
    .select("portal_id")
    .eq("chat_id", chatId);
  if (error) dbError("getUserPortals", error);
  return (data || []).map((r) => r.portal_id);
}

async function getAllSubsMap() {
  const { data, error } = await supabase.from("subscription_portals").select("chat_id, portal_id");
  if (error) dbError("getAllSubsMap", error);
  const map = {};
  for (const row of data || []) {
    const key = String(row.chat_id);
    (map[key] ||= []).push(row.portal_id);
  }
  return map;
}

async function getSubscribersForPortal(portalId) {
  const { data, error } = await supabase
    .from("subscription_portals")
    .select("chat_id")
    .eq("portal_id", portalId);
  if (error) dbError("getSubscribersForPortal", error);
  return (data || []).map((r) => String(r.chat_id));
}

async function subscribeUserToPortal(chatId, portal, meta = {}) {
  await upsertSubscriber(chatId, meta);
  const { error } = await supabase.from("subscription_portals").upsert(
    { chat_id: chatId, portal_id: portal },
    { onConflict: "chat_id,portal_id" }
  );
  if (error) dbError("subscribeUserToPortal", error);
}

async function unsubscribeUserFromPortal(chatId, portal) {
  const { error } = await supabase
    .from("subscription_portals")
    .delete()
    .eq("chat_id", chatId)
    .eq("portal_id", portal);
  if (error) dbError("unsubscribeUserFromPortal", error);
}

async function getAlertSentAt(stateKey) {
  const { data, error } = await supabase
    .from("alert_sent")
    .select("sent_at")
    .eq("state_key", stateKey)
    .maybeSingle();
  if (error) dbError("getAlertSentAt", error);
  return data?.sent_at || null;
}

async function setAlertSent(stateKey) {
  const { error } = await supabase.from("alert_sent").upsert(
    { state_key: stateKey, sent_at: new Date().toISOString() },
    { onConflict: "state_key" }
  );
  if (error) dbError("setAlertSent", error);
}

async function wasAlertSentWithin(stateKey, hours) {
  const sentAt = await getAlertSentAt(stateKey);
  if (!sentAt) return false;
  const hoursSince = (Date.now() - new Date(sentAt).getTime()) / (1000 * 60 * 60);
  return hoursSince < hours;
}

module.exports = {
  upsertSubscriber,
  getUserPortals,
  getAllSubsMap,
  getSubscribersForPortal,
  subscribeUserToPortal,
  unsubscribeUserFromPortal,
  getAlertSentAt,
  setAlertSent,
  wasAlertSentWithin,
};
