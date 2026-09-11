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
const { Client, GatewayIntentBits, Events, REST, Routes, PermissionFlagsBits, MessageFlags } = require("discord.js");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { HANDLERS, allText, reduceBatch, walmartEmbeds } = require("./pipelines");

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
  // Self-heal the classic misconfig: volume mounted AT the file path, making
  // DB_PATH a directory. Storing inside it is still on the volume = persistent.
  let target = DB_PATH;
  try { if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "reposter.db");
    console.log(`[reposter] DB_PATH is a directory (volume mounted at the file path) \u2014 using ${target} instead. Tip: set the volume Mount Path to /data to make this warning go away.`);
  } } catch (_) {}
  const dir = path.dirname(target);
  const MAX = 15;
  for (let i = 1; i <= MAX; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".rw-probe"), String(Date.now()));
      fs.unlinkSync(path.join(dir, ".rw-probe"));
      const d = new DatabaseSync(target);
      d.exec("PRAGMA journal_mode = WAL;");
      console.log(`[reposter] db open at ${target} (attempt ${i})`);
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
const RULE_KINDS = ["amazon", "amazonca", "target", "pc", "walmart", "forward"];
const KIND_LIST = RULE_KINDS.map((k) => `'${k}'`).join(",");
db.exec(`CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN (${KIND_LIST})),
  source_channel_id TEXT NOT NULL,
  target_channel_id TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);`);
/* Migrate an existing rules table whose CHECK predates newer kinds.
   SQLite cannot alter a CHECK constraint, so rebuild-and-swap in one transaction. */
(function migrateRuleKinds() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rules'").get();
  if (!row || RULE_KINDS.every((k) => row.sql.includes(`'${k}'`))) return;
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE rules_migr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN (${KIND_LIST})),
      source_channel_id TEXT NOT NULL,
      target_channel_id TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO rules_migr (id,kind,source_channel_id,target_channel_id,params,enabled,created_at) SELECT id,kind,source_channel_id,target_channel_id,params,enabled,created_at FROM rules");
    db.exec("DROP TABLE rules");
    db.exec("ALTER TABLE rules_migr RENAME TO rules");
    db.exec("COMMIT");
    console.log("[reposter] rules table migrated \u2014 kinds now: " + RULE_KINDS.join(", "));
  } catch (e) { db.exec("ROLLBACK"); throw e; }
})();
db.exec(`CREATE TABLE IF NOT EXISTS links (
  retailer TEXT NOT NULL, sku TEXT NOT NULL, url TEXT NOT NULL,
  PRIMARY KEY (retailer, sku)
);`);
const LINKS = new Map();
const normSku = (retailer, sku) => {
  const s = String(sku || "").trim();
  return ["amazon", "amazonca"].includes(String(retailer || "").toLowerCase()) ? s.toUpperCase() : s;
};
const linkKey = (retailer, sku) => String(retailer || "").toLowerCase() + ":" + normSku(retailer, sku);
function loadLinks() {
  LINKS.clear();
  for (const row of db.prepare("SELECT retailer, sku, url FROM links").all())
    LINKS.set(linkKey(row.retailer, row.sku), row.url);
}
loadLinks();

// ---- control panel (pure builders; component ids are stateless) ----
const PANEL_RETAILERS = ["amazon", "amazonca", "target", "walmart", "pc"];
function panelHome() {
  const routeOpts = RULES.slice(0, 25).map((x) => ({
    label: `#${x.id} ${x.kind}${x.enabled ? "" : " (paused)"}`.slice(0, 100),
    description: ((x.params.keywords ? "kw " + x.params.keywords.join(",") + " \u00b7 " : "")
      + (x.params.confirm ? `confirm ${x.params.confirm}\u00d7` : "") || "tap to manage").slice(0, 100),
    value: String(x.id),
  }));
  const linkOpts = [...LINKS.keys()].slice(0, 25).map((k) => {
    const [rt, sk] = k.split(":");
    return { label: `${rt} \u00b7 ${sk}`.slice(0, 100), value: `${rt}|${sk}` };
  });
  const rows = [];
  if (routeOpts.length) rows.push({ type: 1, components: [{ type: 3, custom_id: "pnl:rsel", placeholder: "Manage a route\u2026", options: routeOpts }] });
  if (linkOpts.length) rows.push({ type: 1, components: [{ type: 3, custom_id: "pnl:lsel", placeholder: "View a preloaded link\u2026", options: linkOpts }] });
  rows.push({ type: 1, components: [
    { type: 2, style: 3, custom_id: "pnl:nr", label: "\u2795 New route" },
    { type: 2, style: 2, custom_id: "pnl:stats", label: "\uD83D\uDCCA Stats" },
    { type: 2, style: 3, custom_id: "pnl:ladd", label: "\u2795 Add / update link" },
    { type: 2, style: 2, custom_id: "pnl:refresh", label: "\uD83D\uDD04 Refresh" },
    { type: 2, style: 2, custom_id: "pnl:guide:panel", label: "\uD83D\uDCD6 Guide" },
  ] });
  const desc = RULES.map((x) => `**#${x.id}** ${x.enabled ? "\uD83D\uDFE2" : "\u26AA"} ${x.kind} <#${x.source_channel_id}> \u2192 <#${x.target_channel_id}>`).join("\n")
    || "No routes yet \u2014 `/route add`.";
  return { embeds: [{ title: "PKMD Reposter \u2014 Control Panel", description: desc.slice(0, 3900), color: 0xf2b33d,
    footer: { text: `${LINKS.size} preloaded link${LINKS.size === 1 ? "" : "s"} \u00b7 visible only to you` } }], components: rows };
}
function routeDetail(x) {
  const p = x.params || {};
  const lines = [
    `**Kind:** ${x.kind}  \u00b7  **Source:** <#${x.source_channel_id}> \u2192 <#${x.target_channel_id}>`,
    `**Filter:** ${p.filter || "(default: tcg)"}  \u00b7  **Keywords:** ${p.keywords ? p.keywords.join(", ") : "\u2014"}`,
    `**Confirm:** ${p.confirm ? `${p.confirm}\u00d7 / ${p.window || 10}m \u00b7 cooldown ${p.cooldown || 60}m` : "immediate"}`,
  ];
  return { embeds: [{ title: `Route #${x.id} ${x.enabled ? "\uD83D\uDFE2 enabled" : "\u26AA paused"}`, description: lines.join("\n"), color: x.enabled ? 0x1db954 : 0x5a6572 }],
    components: [
      { type: 1, components: [
        { type: 2, style: x.enabled ? 2 : 3, custom_id: `pnl:rtg:${x.id}`, label: x.enabled ? "\u23F8 Pause" : "\u25B6 Enable" },
        { type: 2, style: 4, custom_id: `pnl:rrm:${x.id}`, label: "\uD83D\uDDD1 Remove" },
        { type: 2, style: 2, custom_id: "pnl:home", label: "\u2039 Back" },
      ] },
      { type: 1, components: [
        { type: 2, style: 1, custom_id: `pnl:rcs:${x.id}`, label: "\uD83D\uDCE5 Change source" },
        { type: 2, style: 1, custom_id: `pnl:rct:${x.id}`, label: "\uD83D\uDCE4 Change target" },
        { type: 2, style: 1, custom_id: `pnl:redit:${x.id}`, label: "\u2699\uFE0F Edit filters & gates" },
      ] },
    ] };
}
function linkDetail(rt, sk) {
  const url = LINKS.get(linkKey(rt, sk));
  return { embeds: [{ title: `Preloaded link \u2014 ${rt} ${sk}`,
    description: url ? `Reposts for this SKU use:\n${url}` : "(no longer set)", color: 0xf2b33d }],
    components: [{ type: 1, components: [
      { type: 2, style: 4, custom_id: `pnl:lrm:${rt}|${sk}`, label: "\uD83D\uDDD1 Remove link" },
      { type: 2, style: 2, custom_id: "pnl:home", label: "\u2039 Back" },
    ] }] };
}
function channelPick(which, rid) {
  const src = which === "src";
  return { embeds: [{ title: `Route #${rid} \u2014 pick a new ${src ? "source" : "target"} channel`,
    description: src ? "Messages from the selected channel will feed this route."
      : "This route\u2019s reposts will be sent to the selected channel.", color: 0xf2b33d }],
    components: [
      { type: 1, components: [{ type: 8, custom_id: `pnl:${src ? "rcss" : "rcts"}:${rid}`, placeholder: "Select a channel\u2026", channel_types: [0, 5] }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: `pnl:rdet:${rid}`, label: "\u2039 Back" }] },
    ] };
}
function newRouteKind() {
  return { embeds: [{ title: "New route \u2014 step 1 of 3", description: "Pick the pipeline kind.", color: 0xf2b33d }],
    components: [
      { type: 1, components: [{ type: 3, custom_id: "pnl:nrk", placeholder: "Pipeline kind\u2026",
        options: RULE_KINDS.map((k) => ({ label: k, value: k })) }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: "pnl:home", label: "\u2039 Cancel" }] },
    ] };
}
function newRouteChan(step, kind, src) {
  const first = step === "s";
  return { embeds: [{ title: `New ${kind} route \u2014 step ${first ? 2 : 3} of 3`,
    description: first ? "Pick the **source** channel (the feed to read)."
      : `Source: <#${src}>\nNow pick the **target** channel (where reposts go). The route is created immediately with default params \u2014 tcg filter, immediate posting.`, color: 0xf2b33d }],
    components: [
      { type: 1, components: [{ type: 8, custom_id: first ? `pnl:nrs:${kind}` : `pnl:nrt:${kind}:${src}`, placeholder: "Select a channel\u2026", channel_types: [0, 5] }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: "pnl:home", label: "\u2039 Cancel" }] },
    ] };
}
function routeEditModal(x) {
  const p = x.params || {};
  const ti = (cid, label, val, ph, max) => ({ type: 1, components: [{ type: 4, custom_id: cid, style: 1, required: false,
    label, value: val || "", placeholder: ph, max_length: max }] });
  return { custom_id: `pnl:remod:${x.id}`, title: `Route #${x.id} \u2014 filters & gates`, components: [
    ti("filter", "Filter \u2014 what gets through", p.filter, "tcg = Pok\u00e9mon card products only \u00b7 pokemon = anything Pok\u00e9mon \u00b7 off = everything", 10),
    ti("keywords", "Keywords (comma-separated)", p.keywords ? p.keywords.join(", ") : "", "blank = no keyword gate", 200),
    ti("confirm", "Confirm \u2014 pings needed per item", p.confirm ? String(p.confirm) : "", "post after N pings inside the window below \u00b7 blank = immediately", 4),
    ti("window", "Confirm window (minutes)", p.window ? String(p.window) : "", "pings must land within this many minutes to count \u00b7 blank = 10", 4),
    ti("cooldown", "Per-item cooldown (minutes)", p.cooldown ? String(p.cooldown) : "", "blank = 60", 5),
  ] };
}
/* Pure merge: applies the 5 managed fields onto existing params,
   preserving anything else (slug, tag, \u2026). Returns { params } or { error }. */
function applyRouteEdit(existing, f) {
  const p = { ...(existing || {}) };
  for (const k of ["filter", "keywords", "confirm", "window", "cooldown"]) delete p[k];
  const filter = String(f.filter || "").trim().toLowerCase();
  if (filter) {
    if (!["tcg", "pokemon", "off"].includes(filter)) return { error: "Filter must be tcg, pokemon, or off (or blank)." };
    p.filter = filter;
  }
  const kws = String(f.keywords || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (kws.length) p.keywords = kws;
  for (const [k, min] of [["confirm", 2], ["window", 1], ["cooldown", 1]]) {
    const raw = String(f[k] || "").trim();
    if (!raw) continue;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return { error: `${k} must be a positive number (or blank).` };
    if (k === "confirm" && n < min) continue; // 1 = immediate = same as blank
    p[k] = n;
  }
  return { params: p };
}
function linkRetailerPick() {
  const counts = {};
  for (const x of RULES) if (PANEL_RETAILERS.includes(x.kind)) counts[x.kind] = (counts[x.kind] || 0) + 1;
  const ids = PANEL_RETAILERS.filter((k) => counts[k]);
  const opts = (ids.length ? ids : PANEL_RETAILERS).map((k) => ({
    label: k, value: k,
    description: counts[k] ? `${counts[k]} route${counts[k] === 1 ? "" : "s"} on this retailer` : "no routes yet",
  }));
  return { embeds: [{ title: "Preloaded link \u2014 pick the retailer", color: 0xf2b33d,
    description: "The form opens next asking only SKU + URL \u2014 no retailer typing, no typos." }],
    components: [
      { type: 1, components: [{ type: 3, custom_id: "pnl:lret", placeholder: "Retailer\u2026", options: opts }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: "pnl:home", label: "\u2039 Cancel" }] },
    ] };
}
function linkModal(retailer) {
  return { custom_id: `pnl:lmod:${retailer}`, title: `Preloaded link \u2014 ${retailer}`, components: [
    { type: 1, components: [{ type: 4, custom_id: "sku", style: 1, required: true, label: "SKU \u2014 ASIN / TCIN / Walmart item / PC SKU",
      placeholder: "works even before the product first appears in the feed" }] },
    { type: 1, components: [{ type: 4, custom_id: "url", style: 2, required: true, label: "Full affiliate URL" }] },
  ] };
}
const GUIDES = {
  routes: { title: "\uD83D\uDCD6 Routes \u2014 the repost pipelines", text:
`**/route add kind: source: target:** creates a pipeline. Kinds: **amazon**, **amazonca**, **target**, **pc**, **walmart** (batches into rich embeds), **forward** (keyword mirror).
**filter** \u2014 tcg (default: Pok\u00e9mon card products only) \u00b7 pokemon (any Pok\u00e9mon) \u00b7 off. Walmart defaults to off.
**keywords** \u2014 comma list; product text must contain one (accent-proof: "Pokemon" matches "Pok\u00e9mon").
**confirm N** \u2014 post only after N pings for the same item within **window** minutes (default 10); after posting, the item is muted for **cooldown** minutes (default 60). For checkout/monitor feeds; leave off for one-ping deal feeds.
**/route list \u00b7 toggle id \u00b7 remove id** \u2014 or just use **/panel**. To change params: remove + re-add.
Warming/cooldown skips log in Railway as {"skipped":"warming","count":\u2026}.` },
  links: { title: "\uD83D\uDCD6 Preloaded affiliate links \u2014 /link", text:
`**/link set retailer: sku: url:** stores a full replacement link per SKU (ASIN / TCIN / Walmart item ID / PC SKU) in SQLite on the volume \u2014 survives redeploys.
On a matching ping the repost uses **your** link: amazon(.ca) swaps the primary/title/arrow link (Cart & Other Sellers stay tag-built); target/walmart/pc replace it outright.
**/link list \u00b7 remove** \u2014 or **/panel** \u2192 \u2795 Add / update link (form) and the link dropdown to view/remove.
Preloading works **before a product ever appears** \u2014 store a TCIN/ASIN today and the very first matching ping reposts your link. Pairs with the app: **/link** controls Discord reposts; the app\u2019s **Admin \u2192 Links** locks control app alerts (product-keyed, so the item must exist there first \u2014 the app\u2019s pre-load equivalent is affiliate.json skus).` },
  gates: { title: "\uD83D\uDCD6 Filters & burst gates", text:
`Filters read **product text only** (title / description / Product fields) \u2014 a monitor\u2019s "Pokemon Deals" footer can\u2019t fool them.
**tcg** needs a real Pok\u00e9mon signal AND a card-product word (booster, ETB, tin, collection\u2026). **pokemon** needs the brand only.
**confirm N\u00d7/Wm** counts distinct source messages per item (gateway replays are ignored, logged as replay:true). On the Nth ping inside the window it posts once; **cooldown** then mutes that item. Counters are in-memory \u2014 a redeploy resets warm-ups.` },
  panel: { title: "\uD83D\uDCD6 Control panel \u2014 /panel", text:
`**/panel** opens this hub (only you see it). Pick a **route** to pause / enable / remove it (with confirm) \u2014 or tap **\uD83D\uDCE5 Change source / \uD83D\uDCE4 Change target** to re-point it, and **\u2699\uFE0F Edit filters & gates** to change keywords, filter, and confirm/window/cooldown in a prefilled form \u2014 no commands, no remove-and-re-add. **\u2795 New route** walks kind \u2192 source \u2192 target in three taps (default params; use /route add for keywords/confirm). Multiple targets for one feed = create another route on the same source. **\u2795 Add / update link** opens the link form; **\uD83D\uDD04 Refresh** redraws. Guides: **/guide topic:** routes \u00b7 links \u00b7 gates.` },
};
function statsEmbed(statRows) {
  const lines = statRows.map((s) => `**${s.k}**: ${s.v}`).join("\n") || "No traffic yet.";
  const up = Math.floor(process.uptime());
  const h = Math.floor(up / 3600), mn = Math.floor((up % 3600) / 60);
  return { flags: MessageFlags.Ephemeral, embeds: [{ title: "\uD83D\uDCCA Reposter stats", color: 0x35d0ba,
    description: `${DRY_RUN ? "\u26A0 **DRY RUN** \u2014 nothing is actually posting\n" : ""}Routes: **${RULES.filter((x) => x.enabled).length}/${RULES.length} enabled** \u00b7 Preloaded links: **${LINKS.size}**\nUptime: **${h}h ${mn}m** (burst counters reset on redeploy)\n\n${lines}` }] };
}
function guideEmbed(topic) {
  const g = GUIDES[topic] || GUIDES.panel;
  return { flags: MessageFlags.Ephemeral, embeds: [{ title: g.title, description: g.text, color: 0x35d0ba }] };
}
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
      const embeds = walmartEmbeds(uniq);
      for (let i = 0; i < embeds.length; i += 10)
        await send(client, rule.target_channel_id, { embeds: embeds.slice(i, i + 10) }, rule);
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
        text, embeds, content, rule, dedupe, messageId: msg.id,
        linkFor: (rt, sk) => LINKS.get(linkKey(rt, sk)) || null,
        post: (payload) => send(client, rule.target_channel_id, payload, rule).then(() => bump.run("posted:" + rule.kind)),
        batch: batchFor(rule, client),
      };
      const out = await HANDLERS[rule.kind](ctx).catch((e) => ({ error: e.message }));
      if (out && out.error) console.error(`[rule#${rule.id} ${rule.kind}]`, out.error);
      else if (out && (!out.skipped || out.skipped === "warming" || out.skipped === "cooldown")) console.log(`[rule#${rule.id} ${rule.kind}]`, JSON.stringify(out));
      bump.run("seen:" + rule.kind);
    }
  } catch (e) { console.error("[router]", e.message); }
});

/* ---------- slash commands ---------- */
const KINDS = RULE_KINDS;
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
        { type: 3, name: "filter", description: "amazon(.ca)/target/walmart: tcg, pokemon, or off (walmart default: off)", choices: [{ name: "tcg", value: "tcg" }, { name: "pokemon", value: "pokemon" }, { name: "off", value: "off" }] },
        { type: 4, name: "confirm", description: "amazon(.ca)/target/walmart/pc: post after N rapid pings per item (default 1 = immediate)" },
        { type: 4, name: "cooldown", description: "amazon(.ca)/target/walmart/pc: minutes to mute an item after it posts (default 60)" },
        { type: 4, name: "window", description: "amazon(.ca)/target/walmart/pc: rapid-succession window in minutes (default 10)" },
      ]},
      { type: 1, name: "list", description: "List routes" },
      { type: 1, name: "remove", description: "Remove a route", options: [{ type: 4, name: "id", description: "Route id", required: true }] },
      { type: 1, name: "toggle", description: "Enable/disable a route", options: [{ type: 4, name: "id", description: "Route id", required: true }] },
    ],
  },
  {
    name: "link", description: "Preloaded affiliate links per retailer + SKU",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { type: 1, name: "set", description: "Save an affiliate link for a SKU \u2014 reposts use it instead of the source link", options: [
        { type: 3, name: "retailer", description: "Retailer", required: true, choices: ["amazon", "amazonca", "target", "walmart", "pc"].map((k) => ({ name: k, value: k })) },
        { type: 3, name: "sku", description: "ASIN / TCIN / Walmart item ID / PC SKU", required: true },
        { type: 3, name: "url", description: "Full affiliate link to push", required: true },
      ] },
      { type: 1, name: "remove", description: "Remove a saved link", options: [
        { type: 3, name: "retailer", description: "Retailer", required: true, choices: ["amazon", "amazonca", "target", "walmart", "pc"].map((k) => ({ name: k, value: k })) },
        { type: 3, name: "sku", description: "SKU to clear", required: true },
      ] },
      { type: 1, name: "list", description: "List saved links" },
    ],
  },
  { name: "panel", description: "Open the reposter control panel (routes + links, no commands needed)",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild) },
  { name: "guide", description: "How-to guides for the reposter",
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ type: 3, name: "topic", description: "Which guide", choices: ["routes", "links", "gates", "panel"].map((k) => ({ name: k, value: k })) }] },
  { name: "reposter", description: "Reposter status", default_member_permissions: String(PermissionFlagsBits.ManageGuild) },
];

async function handleComponent(i) {
  if (!i.memberPermissions || !i.memberPermissions.has(PermissionFlagsBits.ManageGuild))
    return i.reply({ flags: MessageFlags.Ephemeral, content: "Manage Server permission required." });
  const id = i.customId || "";
  if (i.isModalSubmit()) {
    if (id.startsWith("pnl:remod:")) {
      const rid = +id.split(":")[2];
      const x = RULES.find((z) => z.id === rid);
      if (!x) return i.reply({ flags: MessageFlags.Ephemeral, content: "That route no longer exists." });
      const out = applyRouteEdit(x.params, {
        filter: i.fields.getTextInputValue("filter"),
        keywords: i.fields.getTextInputValue("keywords"),
        confirm: i.fields.getTextInputValue("confirm"),
        window: i.fields.getTextInputValue("window"),
        cooldown: i.fields.getTextInputValue("cooldown"),
      });
      if (out.error) return i.reply({ flags: MessageFlags.Ephemeral, content: "\u26A0 " + out.error });
      db.prepare("UPDATE rules SET params=? WHERE id=?").run(JSON.stringify(out.params), rid);
      reload();
      const fresh = RULES.find((z) => z.id === rid);
      if (i.isFromMessage()) return i.update(routeDetail(fresh));
      return i.reply({ flags: MessageFlags.Ephemeral, content: `Route #${rid} updated.` });
    }
    if (!id.startsWith("pnl:lmod")) return;
    const fromId = id.split(":")[2];
    const retailer = (fromId || i.fields.getTextInputValue("retailer")).trim().toLowerCase();
    const url = i.fields.getTextInputValue("url").trim();
    if (!PANEL_RETAILERS.includes(retailer))
      return i.reply({ flags: MessageFlags.Ephemeral, content: "Retailer must be one of: " + PANEL_RETAILERS.join(", ") + "." });
    if (!/^https?:\/\//i.test(url))
      return i.reply({ flags: MessageFlags.Ephemeral, content: "URL must start with http(s)://" });
    const sku = normSku(retailer, i.fields.getTextInputValue("sku"));
    db.prepare("INSERT INTO links(retailer,sku,url) VALUES(?,?,?) ON CONFLICT(retailer,sku) DO UPDATE SET url=excluded.url").run(retailer, sku, url);
    loadLinks();
    if (i.isFromMessage()) return i.update(panelHome());
    return i.reply({ flags: MessageFlags.Ephemeral, content: `Saved \u2014 **${retailer}** \`${sku}\` will repost with your preloaded link.` });
  }
  if (i.isStringSelectMenu()) {
    if (id === "pnl:rsel") { const x = RULES.find((z) => String(z.id) === i.values[0]); return i.update(x ? routeDetail(x) : panelHome()); }
    if (id === "pnl:lsel") { const [rt, sk] = i.values[0].split("|"); return i.update(linkDetail(rt, sk)); }
    if (id === "pnl:nrk") return i.update(newRouteChan("s", i.values[0]));
    if (id === "pnl:lret") return i.showModal(linkModal(i.values[0]));
    return;
  }
  if (i.isChannelSelectMenu()) {
    const ch = i.values[0];
    if (id.startsWith("pnl:rcss:")) {
      const rid = +id.split(":")[2];
      db.prepare("UPDATE rules SET source_channel_id=? WHERE id=?").run(ch, rid); reload();
      const x = RULES.find((z) => z.id === rid); return i.update(x ? routeDetail(x) : panelHome());
    }
    if (id.startsWith("pnl:rcts:")) {
      const rid = +id.split(":")[2];
      db.prepare("UPDATE rules SET target_channel_id=? WHERE id=?").run(ch, rid); reload();
      const x = RULES.find((z) => z.id === rid); return i.update(x ? routeDetail(x) : panelHome());
    }
    if (id.startsWith("pnl:nrs:")) return i.update(newRouteChan("t", id.split(":")[2], ch));
    if (id.startsWith("pnl:nrt:")) {
      const [, , kind, src] = id.split(":");
      const info = db.prepare("INSERT INTO rules(kind,source_channel_id,target_channel_id,params,enabled,created_at) VALUES(?,?,?,?,1,?)")
        .run(kind, src, ch, "{}", Date.now());
      reload();
      const x = RULES.find((z) => z.id === Number(info.lastInsertRowid));
      return i.update(x ? routeDetail(x) : panelHome());
    }
    return;
  }
  if (!i.isButton()) return;
  if (id === "pnl:home" || id === "pnl:refresh") return i.update(panelHome());
  if (id === "pnl:nr") return i.update(newRouteKind());
  if (id === "pnl:stats") return i.reply(statsEmbed(db.prepare("SELECT k,v FROM stats ORDER BY k").all()));
  if (id.startsWith("pnl:rdet:")) { const x = RULES.find((z) => z.id === +id.split(":")[2]); return i.update(x ? routeDetail(x) : panelHome()); }
  if (id.startsWith("pnl:redit:")) {
    const x = RULES.find((z) => z.id === +id.split(":")[2]);
    return x ? i.showModal(routeEditModal(x)) : i.update(panelHome());
  }
  if (id.startsWith("pnl:rcs:")) return i.update(channelPick("src", id.split(":")[2]));
  if (id.startsWith("pnl:rct:")) return i.update(channelPick("tgt", id.split(":")[2]));
  if (id === "pnl:ladd") return i.update(linkRetailerPick());
  if (id.startsWith("pnl:guide:")) return i.reply(guideEmbed(id.split(":")[2]));
  if (id.startsWith("pnl:rtg:")) {
    const rid = +id.split(":")[2]; const x = RULES.find((z) => z.id === rid);
    if (!x) return i.update(panelHome());
    db.prepare("UPDATE rules SET enabled=? WHERE id=?").run(x.enabled ? 0 : 1, rid); reload();
    return i.update(routeDetail(RULES.find((z) => z.id === rid)));
  }
  if (id.startsWith("pnl:rrmc:")) { db.prepare("DELETE FROM rules WHERE id=?").run(+id.split(":")[2]); reload(); return i.update(panelHome()); }
  if (id.startsWith("pnl:rrm:")) {
    const rid = id.split(":")[2];
    return i.update({ embeds: [{ title: `Remove route #${rid}?`, description: "This deletes the route permanently.", color: 0xff6b6b }],
      components: [{ type: 1, components: [
        { type: 2, style: 4, custom_id: `pnl:rrmc:${rid}`, label: "Yes, remove it" },
        { type: 2, style: 2, custom_id: "pnl:home", label: "Cancel" }] }] });
  }
  if (id.startsWith("pnl:lrm:")) {
    const [rt, sk] = id.slice(8).split("|");
    db.prepare("DELETE FROM links WHERE retailer=? AND sku=?").run(rt, sk); loadLinks();
    return i.update(panelHome());
  }
}
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton() || i.isStringSelectMenu() || i.isChannelSelectMenu() || i.isModalSubmit()) return handleComponent(i);
    if (!i.isChatInputCommand()) return;
    if (i.commandName === "panel") return i.reply({ ...panelHome(), flags: MessageFlags.Ephemeral });
    if (i.commandName === "guide") return i.reply(guideEmbed(i.options.getString("topic") || "panel"));
    if (i.commandName === "reposter") {
      const stats = db.prepare("SELECT k,v FROM stats ORDER BY k").all().map((s) => `${s.k}: ${s.v}`).join(" · ") || "no traffic yet";
      return i.reply({ flags: MessageFlags.Ephemeral, content:
        `**PKMD Reposter** · up ${Math.floor((Date.now() - START) / 60000)}m · ${RULES.filter((r) => r.enabled).length}/${RULES.length} routes on${DRY ? " · **DRY RUN**" : ""}\n${stats}` });
    }
    if (i.commandName === "link") {
      const sub = i.options.getSubcommand();
      if (sub === "set") {
        const retailer = i.options.getString("retailer");
        const sku = normSku(retailer, i.options.getString("sku"));
        const url = i.options.getString("url").trim();
        if (!/^https?:\/\//i.test(url)) return i.reply({ flags: MessageFlags.Ephemeral, content: "URL must start with http(s)://" });
        db.prepare("INSERT INTO links(retailer,sku,url) VALUES(?,?,?) ON CONFLICT(retailer,sku) DO UPDATE SET url=excluded.url")
          .run(retailer, sku, url);
        loadLinks();
        return i.reply({ flags: MessageFlags.Ephemeral, content: `Saved \u2014 **${retailer}** \`${sku}\` will now repost with your preloaded link.` });
      }
      if (sub === "remove") {
        const retailer = i.options.getString("retailer");
        const sku = normSku(retailer, i.options.getString("sku"));
        const n = db.prepare("DELETE FROM links WHERE retailer=? AND sku=?").run(retailer, sku).changes;
        loadLinks();
        return i.reply({ flags: MessageFlags.Ephemeral, content: n ? `Removed **${retailer}** \`${sku}\`.` : "No such link." });
      }
      const rows = db.prepare("SELECT retailer, sku, url FROM links ORDER BY retailer, sku").all();
      return i.reply({ flags: MessageFlags.Ephemeral, content:
        rows.map((x) => `**${x.retailer}** \`${x.sku}\` \u2192 ${x.url}`).join("\n").slice(0, 1900) || "No preloaded links yet \u2014 `/link set`." });
    }
    if (i.commandName !== "route") return;
    const sub = i.options.getSubcommand();
    if (sub === "add") {
      const kind = i.options.getString("kind");
      const params = {};
      const kw = i.options.getString("keywords");
      if (kw) params.keywords = kw.split(",").map((s) => s.trim()).filter(Boolean);
      const flt = i.options.getString("filter"); if (flt) params.filter = flt;
      for (const k of ["confirm", "cooldown", "window"]) {
        const v = i.options.getInteger(k); if (v) params[k] = v;
      }
      const info = db.prepare("INSERT INTO rules(kind,source_channel_id,target_channel_id,params,created_at) VALUES(?,?,?,?,?)")
        .run(kind, i.options.getChannel("source").id, i.options.getChannel("target").id, JSON.stringify(params), Date.now());
      reload();
      return i.reply({ flags: MessageFlags.Ephemeral, content: `Route **#${info.lastInsertRowid}** added: ${kind} <#${i.options.getChannel("source").id}> → <#${i.options.getChannel("target").id}>` });
    }
    if (sub === "list") {
      const lines = RULES.map((r) => `**#${r.id}** ${r.enabled ? "🟢" : "⚪"} ${r.kind} <#${r.source_channel_id}> → <#${r.target_channel_id}>${r.params.keywords ? " · kw: " + r.params.keywords.join(", ") : ""}${r.params.filter ? " \u00b7 filter: " + r.params.filter : ""}${r.params.confirm ? ` \u00b7 confirm ${r.params.confirm}\u00d7/${r.params.window || 10}m \u00b7 cooldown ${r.params.cooldown || 60}m` : ""}`);
      return i.reply({ flags: MessageFlags.Ephemeral, content: lines.join("\n") || "No routes yet — `/route add`." });
    }
    if (sub === "remove") {
      const n = db.prepare("DELETE FROM rules WHERE id=?").run(i.options.getInteger("id")).changes;
      reload();
      return i.reply({ flags: MessageFlags.Ephemeral, content: n ? `Route #${i.options.getInteger("id")} removed.` : "No such route." });
    }
    if (sub === "toggle") {
      const id = i.options.getInteger("id");
      const r = db.prepare("SELECT enabled FROM rules WHERE id=?").get(id);
      if (!r) return i.reply({ flags: MessageFlags.Ephemeral, content: "No such route." });
      db.prepare("UPDATE rules SET enabled=? WHERE id=?").run(r.enabled ? 0 : 1, id);
      reload();
      return i.reply({ flags: MessageFlags.Ephemeral, content: `Route #${id} ${r.enabled ? "paused ⚪" : "enabled 🟢"}.` });
    }
  } catch (e) {
    console.error("[cmd]", e.message);
    if (i.isRepliable()) i.reply({ flags: MessageFlags.Ephemeral, content: "Error: " + e.message }).catch(() => {});
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
