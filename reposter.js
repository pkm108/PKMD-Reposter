/**
 * PKMD Reposter — one bot, four pipelines (amazon | pc | walmart | forward).
 * Replaces: amazon-deal-repost, pokemon-center-repost, walmart-link-batching,
 * and the /forward keyword bot — one gateway connection, ONE Message Content review.
 *
 * Env:
 *   DISCORD_TOKEN   (required) bot token of the surviving "PKMD Reposter" application
 *   GUILD_ID        (required) your server id — commands register here; other guilds ignored
 *   DB_PATH         default /data/reposter.db  (attach a Railway volume at /data)
 *   AMAZON_TAG      default stocktcg-20
 *   DRY_RUN=1       log what WOULD post, without posting (parallel-run cutover mode)
 *   DEDUPE_MINUTES  default 30 · WALMART_BATCH_SIZE default 5 · WALMART_BATCH_SECONDS default 20
 *   PORT            health endpoint (Railway)
 */
const { Client, GatewayIntentBits, Events, REST, Routes, PermissionFlagsBits } = require("discord.js");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { HANDLERS, allText, reduceBatch, walmartEmbed } = require("./pipelines");

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DB_PATH = String(process.env.DB_PATH || "/data/reposter.db").trim().replace(/^["']|["']$/g, "");
const DRY = process.env.DRY_RUN === "1";
const DEDUPE_MS = (parseInt(process.env.DEDUPE_MINUTES || "30", 10)) * 60000;
const BATCH_N = parseInt(process.env.WALMART_BATCH_SIZE || "5", 10);
const BATCH_S = parseInt(process.env.WALMART_BATCH_SECONDS || "20", 10);
if (!TOKEN || !GUILD_ID) { console.error("[reposter] DISCORD_TOKEN and GUILD_ID are required"); process.exit(1); }

/* ---------- storage (volume-guarded like the main app) ----------
   Railway can start the container a beat before the volume finishes mounting,
   so we probe-and-retry instead of crashing into a restart loop. */
function openDb() {
  const dir = path.dirname(DB_PATH);
  const MAX = 15;
  for (let i = 1; i <= MAX; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".rw-probe"), String(Date.now()));
      fs.unlinkSync(path.join(dir, ".rw-probe"));
      const d = new DatabaseSync(DB_PATH);
      d.exec("PRAGMA journal_mode = WAL;");
      console.log(`[reposter] db open at ${DB_PATH} (attempt ${i})`);
      return d;
    } catch (e) {
      console.error(`[reposter] db not ready (attempt ${i}/${MAX}) — ${e.message} · DB_PATH=${JSON.stringify(DB_PATH)} dir=${JSON.stringify(dir)}`);
      if (i === MAX) {
        console.error("[reposter] FATAL: cannot open database.");
        console.error("  Check: (1) service Settings \u2192 Volumes shows a volume with Mount Path exactly /data");
        console.error("         (2) Variables \u2192 DB_PATH is exactly /data/reposter.db \u2014 no quotes, no spaces");
        process.exit(1);
      }
      const ms = 2000;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // sync sleep before client exists
    }
  }
}
const db = openDb();
db.exec(`CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('amazon','pc','walmart','forward')),
  source_channel_id TEXT NOT NULL,
  target_channel_id TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);`);
const bump = db.prepare("INSERT INTO stats(k,v) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET v=v+1");
const ruleRows = () => db.prepare("SELECT * FROM rules ORDER BY id").all()
  .map((r) => ({ ...r, params: JSON.parse(r.params || "{}") }));
let RULES = ruleRows();
const reload = () => { RULES = ruleRows(); };

/* one-time env seeding for zero-touch first deploy:
   ROUTES_JSON=[{"kind":"amazon","source":"123","target":"456","params":{}}] */
(function seedFromEnv() {
  if (db.prepare("SELECT COUNT(*) n FROM rules").get().n > 0 || !process.env.ROUTES_JSON) return;
  try {
    for (const r of JSON.parse(process.env.ROUTES_JSON))
      db.prepare("INSERT INTO rules(kind,source_channel_id,target_channel_id,params,created_at) VALUES(?,?,?,?,?)")
        .run(r.kind, String(r.source), String(r.target), JSON.stringify(r.params || {}), Date.now());
    reload();
    console.log(`[reposter] seeded ${RULES.length} rule(s) from ROUTES_JSON`);
  } catch (e) { console.error("[reposter] ROUTES_JSON parse failed:", e.message); }
})();

/* ---------- dedupe (LRU-ish with TTL) ---------- */
const seen = new Map();
function dedupe(key) {
  const now = Date.now();
  if (seen.size > 4000) for (const [k, t] of seen) { if (now - t > DEDUPE_MS) seen.delete(k); if (seen.size < 3000) break; }
  const t = seen.get(key);
  if (t && now - t < DEDUPE_MS) return false;
  seen.set(key, now);
  return true;
}

/* ---------- walmart batching buffers ---------- */
const buffers = new Map(); // ruleId -> { items:[], timer }
function batchFor(rule, client) {
  return (items) => {
    let b = buffers.get(rule.id);
    if (!b) { b = { items: [], timer: null }; buffers.set(rule.id, b); }
    b.items.push(...items);
    const flush = async () => {
      clearTimeout(b.timer); buffers.delete(rule.id);
      const uniq = reduceBatch(b.items);
      if (!uniq.length) return;
      await send(client, rule.target_channel_id, { embeds: [walmartEmbed(uniq)] }, rule);
      bump.run("posted:walmart");
    };
    if (b.items.length >= BATCH_N) flush().catch((e) => console.error("[walmart flush]", e.message));
    else if (!b.timer) b.timer = setTimeout(() => flush().catch((e) => console.error("[walmart flush]", e.message)), BATCH_S * 1000);
  };
}

/* ---------- posting ---------- */
async function send(client, channelId, payload, rule) {
  if (DRY) { console.log(`[dry] rule#${rule.id} ${rule.kind} -> #${channelId}:`, JSON.stringify(payload).slice(0, 300)); return; }
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) { console.error(`[reposter] rule#${rule.id}: target channel ${channelId} unavailable`); return; }
  await ch.send(payload).catch((e) => console.error(`[reposter] send failed rule#${rule.id}:`, e.message));
}

/* ---------- router ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const START = Date.now();

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author && msg.author.id === client.user.id) return;         // never read our own posts
    if (msg.guildId !== GUILD_ID) return;                               // single-server by design
    const rules = RULES.filter((r) => r.enabled && r.source_channel_id === msg.channelId);
    if (!rules.length) return;
    const embeds = (msg.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e));
    const content = msg.content || "";
    const text = allText(embeds, content);
    for (const rule of rules) {
      const ctx = {
        text, embeds, content, rule, dedupe,
        post: (payload) => send(client, rule.target_channel_id, payload, rule).then(() => bump.run("posted:" + rule.kind)),
        batch: batchFor(rule, client),
      };
      const out = await HANDLERS[rule.kind](ctx).catch((e) => ({ error: e.message }));
      if (out && out.error) console.error(`[rule#${rule.id} ${rule.kind}]`, out.error);
      else if (out && !out.skipped) console.log(`[rule#${rule.id} ${rule.kind}]`, JSON.stringify(out));
      bump.run("seen:" + rule.kind);
    }
  } catch (e) { console.error("[router]", e.message); }
});

/* ---------- slash commands ---------- */
const KINDS = ["amazon", "pc", "walmart", "forward"];
const COMMANDS = [
  {
    name: "route", description: "Manage reposter routes",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { type: 1, name: "add", description: "Add a route", options: [
        { type: 3, name: "kind", description: "Pipeline", required: true, choices: KINDS.map((k) => ({ name: k, value: k })) },
        { type: 7, name: "source", description: "Source channel (monitor feed)", required: true },
        { type: 7, name: "target", description: "Target channel (where reposts go)", required: true },
        { type: 3, name: "keywords", description: "forward only: comma-separated keywords" },
        { type: 3, name: "filter", description: "amazon only: pokemon (default) or off", choices: [{ name: "pokemon", value: "pokemon" }, { name: "off", value: "off" }] },
      ]},
      { type: 1, name: "list", description: "List routes" },
      { type: 1, name: "remove", description: "Remove a route", options: [{ type: 4, name: "id", description: "Route id", required: true }] },
      { type: 1, name: "toggle", description: "Enable/disable a route", options: [{ type: 4, name: "id", description: "Route id", required: true }] },
    ],
  },
  { name: "reposter", description: "Reposter status", default_member_permissions: String(PermissionFlagsBits.ManageGuild) },
];

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === "reposter") {
      const stats = db.prepare("SELECT k,v FROM stats ORDER BY k").all().map((s) => `${s.k}: ${s.v}`).join(" · ") || "no traffic yet";
      return i.reply({ ephemeral: true, content:
        `**PKMD Reposter** · up ${Math.floor((Date.now() - START) / 60000)}m · ${RULES.filter((r) => r.enabled).length}/${RULES.length} routes on${DRY ? " · **DRY RUN**" : ""}\n${stats}` });
    }
    if (i.commandName !== "route") return;
    const sub = i.options.getSubcommand();
    if (sub === "add") {
      const kind = i.options.getString("kind");
      const params = {};
      const kw = i.options.getString("keywords");
      if (kw) params.keywords = kw.split(",").map((s) => s.trim()).filter(Boolean);
      const flt = i.options.getString("filter"); if (flt) params.filter = flt;
      const info = db.prepare("INSERT INTO rules(kind,source_channel_id,target_channel_id,params,created_at) VALUES(?,?,?,?,?)")
        .run(kind, i.options.getChannel("source").id, i.options.getChannel("target").id, JSON.stringify(params), Date.now());
      reload();
      return i.reply({ ephemeral: true, content: `Route **#${info.lastInsertRowid}** added: ${kind} <#${i.options.getChannel("source").id}> → <#${i.options.getChannel("target").id}>` });
    }
    if (sub === "list") {
      const lines = RULES.map((r) => `**#${r.id}** ${r.enabled ? "🟢" : "⚪"} ${r.kind} <#${r.source_channel_id}> → <#${r.target_channel_id}>${r.params.keywords ? " · kw: " + r.params.keywords.join(", ") : ""}`);
      return i.reply({ ephemeral: true, content: lines.join("\n") || "No routes yet — `/route add`." });
    }
    if (sub === "remove") {
      const n = db.prepare("DELETE FROM rules WHERE id=?").run(i.options.getInteger("id")).changes;
      reload();
      return i.reply({ ephemeral: true, content: n ? `Route #${i.options.getInteger("id")} removed.` : "No such route." });
    }
    if (sub === "toggle") {
      const id = i.options.getInteger("id");
      const r = db.prepare("SELECT enabled FROM rules WHERE id=?").get(id);
      if (!r) return i.reply({ ephemeral: true, content: "No such route." });
      db.prepare("UPDATE rules SET enabled=? WHERE id=?").run(r.enabled ? 0 : 1, id);
      reload();
      return i.reply({ ephemeral: true, content: `Route #${id} ${r.enabled ? "paused ⚪" : "enabled 🟢"}.` });
    }
  } catch (e) {
    console.error("[cmd]", e.message);
    if (i.isRepliable()) i.reply({ ephemeral: true, content: "Error: " + e.message }).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[reposter] online as ${client.user.tag} · ${RULES.length} route(s) · ${DRY ? "DRY RUN" : "live"} · db=${DB_PATH}`);
  try {
    const rest = new REST().setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: COMMANDS });
    console.log("[reposter] slash commands registered");
  } catch (e) { console.error("[reposter] command registration failed:", e.message); }
});

/* ---------- health (Railway) ---------- */
const app = express();
app.get("/health", (_q, s) => s.json({ ok: true, up_s: Math.floor((Date.now() - START) / 1000), routes: RULES.length, dry: DRY }));
app.listen(process.env.PORT || 3000, () => {});

client.login(TOKEN);
