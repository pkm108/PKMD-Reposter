/**
 * pipelines.js — pure transform logic for the PKMD unified Reposter.
 * Each pipeline exposes pure helpers (unit-testable, no Discord objects needed)
 * plus a handle(ctx) used by the router. ctx = { text, embeds, rule, post, dedupe }.
 *   text   : concatenated searchable text of the message
 *   embeds : plain-object embeds (embed.toJSON() shapes)
 *   rule   : { id, kind, source_channel_id, target_channel_id, params }
 *   post   : async ({ content?, embeds? }) => sends to rule.target_channel_id (or logs in DRY_RUN)
 *   dedupe : (key) => true if fresh (and records it), false if recently seen
 */

const AMAZON_TAG = process.env.AMAZON_TAG || "stocktcg-20";

/* ---------------- shared helpers ---------------- */

const PRICE_RE = /\$\s?\d{1,4}(?:[.,]\d{2})?/;

function embedText(e) {
  return [
    e.author && e.author.name, e.title, e.description,
    ...(e.fields || []).flatMap((f) => [f.name, f.value]),
    e.footer && e.footer.text, e.url,
  ].filter(Boolean).join("\n");
}

function allText(embeds, content) {
  return [content || "", ...(embeds || []).map(embedText)].join("\n");
}

/* Product-scoped text for FILTER decisions: titles, descriptions, and product-ish
   field values only. Excludes footers/authors so a monitor named "Pokemon Deals &
   Alerts" can't make every item look like a Pokémon product. */
function productText(embeds, content) {
  const parts = [content || ""];
  for (const e of embeds || []) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || [])
      if (/product|item|title|name/i.test(f.name || "")) parts.push(f.value || "");
  }
  return parts.join("\n");
}

function keywordsOk(p, ptext) {
  const kws = Array.isArray(p.keywords) ? p.keywords.filter(Boolean) : [];
  if (!kws.length) return true;
  const t = fold(ptext).toLowerCase();
  return kws.some((k) => t.includes(fold(k).toLowerCase()));
}

function firstImage(embeds) {
  for (const e of embeds || []) {
    if (e.image && e.image.url) return e.image.url;
    if (e.thumbnail && e.thumbnail.url) return e.thumbnail.url;
  }
  return null;
}

function firstPrice(embeds, content) {
  for (const e of embeds || []) {
    for (const f of e.fields || [])
      if (/price/i.test(f.name || "")) { const m = String(f.value || "").match(PRICE_RE); if (m) return m[0].replace(/\s/g, ""); }
  }
  const m = allText(embeds, content).match(PRICE_RE);
  return m ? m[0].replace(/\s/g, "") : null;
}

function urlsIn(text) {
  return [...new Set((String(text || "").match(/https?:\/\/[^\s<>()"'\]]+/g) || [])
    .map((u) => u.replace(/[.,;!?]+$/, "")))];
}

/* Accent-fold so "Pokémon" matches "pokemon" (and user keywords typed either way). */
function fold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/* True Pokémon signal only: brand names + Pokémon set names.
   Generic TCG words (booster, etb, tcg…) belong to TCG_RE, not here —
   otherwise any trading-card product "looks Pokémon". */
function looksPokemon(text) {
  return /pokemon|pkmn|prismatic|surging sparks|scarlet & violet|\b151\b|mega evolution/i.test(fold(text));
}

function slugify(s) {
  return String(s || "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
}

/* ---------------- amazon pipeline ---------------- */
/* Refract-style Amazon deal feeds → clean embed with our affiliate tag.
   - Pokémon filter (params.filter !== "off")
   - US-only: never touch or repost non-.com amazon domains (tag is US program)
   - ASIN dedupe via ctx.dedupe                                                   */

function asinOf(url) {
  const m = String(url || "").match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/)([A-Z0-9]{10})(?:[/?]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function amazonHostOk(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "amazon.com" || h.endsWith(".amazon.com");
  } catch (_) { return false; }
}

function affiliateUrl(asin, tag = AMAZON_TAG) {
  return `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(tag)}`;
}

const AMZ_SELLER = "ATVPDKIKX0DER";        // Amazon.com retail
const AMZ_BIZ_SELLER = "A2Q1LRYTXHYQ2K";   // Amazon Business
function amzLinks(asin, tag = AMAZON_TAG) {
  const t = encodeURIComponent(tag);
  return {
    regular:  `https://www.amazon.com/gp/product/${asin}?smid=${AMZ_SELLER}&tag=${t}&psc=1`,
    cart:     `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1&tag=${t}&merchant=${AMZ_SELLER}&seller=${AMZ_SELLER}`,
    offers:   `https://www.amazon.com/dp/${asin}?tag=${t}&merchant=${AMZ_SELLER}&seller=${AMZ_SELLER}&aod=1`,
    business: `https://www.amazon.com/dp/${asin}?tag=${t}&merchant=${AMZ_BIZ_SELLER}&seller=${AMZ_BIZ_SELLER}`,
  };
}

/* TCG-only filter: Pokémon AND a card-product signal in the text. */
const TCG_RE = /(\btcg\b|trading\s*cards?|booster|elite\s*trainer|\betbs?\b|collection|\btins?\b|blister|\bdecks?\b|premium|box\s*set|\bcards\b|\bpsa\b|graded)/i;
function looksTCG(text) { return looksPokemon(text) && TCG_RE.test(fold(text)); }

/* Burst confirmation + per-item cooldown.
   need pings for the same (rule, asin) within windowMs before posting;
   after a confirmed post, that item is muted for cooldownMs. */
const BURST = new Map();
function burstFor(key) {
  if (BURST.size > 2000) { const now = Date.now();
    for (const [k, r] of BURST) if (!r.hits.length && now > r.coolUntil) BURST.delete(k); }
  let r = BURST.get(key);
  if (!r) { r = { hits: [], coolUntil: 0, ids: [] }; BURST.set(key, r); }
  return r;
}
function burstGate(rec, now, { need, windowMs, cooldownMs, msgId }) {
  if (now < rec.coolUntil) return { allow: false, reason: "cooldown", until: rec.coolUntil };
  if (msgId) {
    rec.ids = rec.ids || [];
    if (rec.ids.includes(msgId)) {
      rec.hits = rec.hits.filter((t) => now - t <= windowMs);
      return { allow: false, reason: "warming", count: rec.hits.length, need, replay: true };
    }
    rec.ids.push(msgId);
    if (rec.ids.length > 60) rec.ids.splice(0, rec.ids.length - 60);
  }
  rec.hits = rec.hits.filter((t) => now - t <= windowMs);
  rec.hits.push(now);
  if (rec.hits.length < need) return { allow: false, reason: "warming", count: rec.hits.length, need };
  rec.hits = [];
  rec.coolUntil = now + cooldownMs;
  return { allow: true };
}
function resetBursts() { BURST.clear(); }
/* Shared gate: burst-confirm + cooldown when params.confirm > 1, else plain dedupe. */
function confirmGate(ctx, p, itemKey) {
  const need = Math.max(1, parseInt(p.confirm, 10) || 1);
  if (need > 1) {
    const windowMs = Math.max(1, parseInt(p.window, 10) || 10) * 60000;
    const cooldownMs = Math.max(1, parseInt(p.cooldown, 10) || 60) * 60000;
    const g = burstGate(burstFor(ctx.rule.id + ":" + itemKey), ctx.now || Date.now(), { need, windowMs, cooldownMs, msgId: ctx.messageId });
    if (!g.allow) return g.reason === "warming"
      ? Object.assign({ skipped: "warming", count: g.count, need }, g.replay ? { replay: true } : {})
      : { skipped: "cooldown", until: g.until };
    return null;
  }
  return ctx.dedupe(itemKey) ? null : { skipped: "dupe" };
}

async function handleAmazon(ctx) {
  const { embeds, text, content, rule, post, dedupe } = ctx;
  const p = rule.params || {};
  const ptext = productText(embeds, content);
  const mode = p.filter || "tcg";
  if (mode === "tcg" && !looksTCG(ptext)) return { skipped: "filter" };
  if (mode === "pokemon" && !looksPokemon(ptext)) return { skipped: "filter" };
  if (!keywordsOk(p, ptext)) return { skipped: "keywords" };
  const cand = urlsIn(text).filter(amazonHostOk);
  const asin = cand.map(asinOf).find(Boolean);
  if (!asin) return { skipped: "no-asin" };
  const gate = confirmGate(ctx, p, "amz:" + asin);
  if (gate) return { ...gate, asin };
  const src = (embeds && embeds[0]) || {};
  const title = (src.title && !/checkout|success/i.test(src.title) ? src.title : null)
    || (src.fields || []).find((f) => /product|item|title/i.test(f.name || ""))?.value
    || "Amazon deal";
  const price = firstPrice(embeds, text);
  const L = amzLinks(asin, p.tag || AMAZON_TAG);
  await post({
    embeds: [{
      title: String(title).replace(/\[|\]\(.*?\)/g, "").slice(0, 240),
      url: L.regular,
      color: 0xf2b33d,
      thumbnail: firstImage(embeds) ? { url: firstImage(embeds) } : undefined,
      fields: [
        { name: "Price", value: price || "\u2014", inline: true },
        { name: "Buy Now", value: `\uD83D\uDD35 [Amazon](${L.regular})`, inline: true },
        { name: "\u200b", value: [
          `\u27A1\uFE0F ${L.regular}`,
          `\uD83D\uDED2 [Add to Cart](${L.cart})`,
          `\uD83D\uDCCB [Other Sellers Tab](${L.offers})`,
          `\uD83D\uDCBC [Amazon Business Link](${L.business})`,
          `*Note: If the product doesn\u2019t appear at first, try the Add to Cart link or select Amazon from the \u201COther Sellers\u201D tab on the listing.*`,
        ].join("\n\n"), inline: false },
      ],
      footer: { text: "Pokemon Deals & News - PKMD #ad" },
    }],
  });
  return { posted: true, asin };
}

/* ---------------- target pipeline ---------------- */
/* Refract checkout-log feeds → branded Target links.
   Source links look like target.com/p/~/-/A-<TCIN>; reposts use /p/<slug>/A-<TCIN>
   (Target ignores the slug segment). Same filter + confirm/cooldown gates as amazon. */

function targetHostOk(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "target.com" || h.endsWith(".target.com");
  } catch (_) { return false; }
}

function targetTcin(text) {
  for (const u of urlsIn(text)) {
    if (!targetHostOk(u)) continue;
    const m = String(u).match(/\/A-(\d{6,12})(?:[/?#]|$)/i);
    if (m) return m[1];
  }
  return null;
}

function targetUrl(tcin, slug = "pkmd") {
  return `https://www.target.com/p/${slugify(slug) || "pkmd"}/A-${tcin}`;
}

async function handleTarget(ctx) {
  const { embeds, text, content, rule, post } = ctx;
  const p = rule.params || {};
  const ptext = productText(embeds, content);
  const mode = p.filter || "tcg";
  if (mode === "tcg" && !looksTCG(ptext)) return { skipped: "filter" };
  if (mode === "pokemon" && !looksPokemon(ptext)) return { skipped: "filter" };
  if (!keywordsOk(p, ptext)) return { skipped: "keywords" };
  const tcin = targetTcin(text);
  if (!tcin) return { skipped: "no-tcin" };
  const gate = confirmGate(ctx, p, "tgt:" + tcin);
  if (gate) return { ...gate, tcin };
  const src = (embeds && embeds[0]) || {};
  const title = (src.fields || []).find((f) => /product|item|title/i.test(f.name || ""))?.value
    || (src.title && !/checkout|success|carted|logs/i.test(src.title) ? src.title : null)
    || "Target restock";
  const link = targetUrl(tcin, p.slug);
  const price = firstPrice(embeds, text);
  await post({
    embeds: [{
      title: String(title).replace(/\[|\]\(.*?\)/g, "").slice(0, 240),
      url: link,
      color: 0xcc0000,
      thumbnail: firstImage(embeds) ? { url: firstImage(embeds) } : undefined,
      fields: [
        { name: "Price", value: price || "\u2014", inline: true },
        { name: "Buy Now", value: `\uD83C\uDFAF [Target](${link})`, inline: true },
        { name: "\u200b", value: `\u27A1\uFE0F ${link}`, inline: false },
      ],
      footer: { text: "Pokemon Deals & News - PKMD #ad" },
    }],
  });
  return { posted: true, tcin };
}

/* ---------------- pokemon center pipeline ---------------- */
/* Valor AIO PC checkout feeds → generated product URL.
   SKU patterns: "100-10464", "10-10101", or pokemoncenter.com link in embed.
   US only: skip if text mentions pokemoncenter.ca / .co.uk unless params.region overrides. */

function pcSku(text) {
  const m = String(text || "").match(/\b(\d{2,4}-\d{4,6})\b/);
  if (m) return m[1];
  const u = String(text || "").match(/pokemoncenter\.com\/(?:[a-z-]+\/)?product\/([A-Za-z0-9-]+)/i);
  return u ? u[1] : null;
}

function pcUrl(sku, title) {
  const slug = slugify(title || "");
  return `https://www.pokemoncenter.com/product/${sku}${slug ? "/" + slug : ""}`;
}

async function handlePC(ctx) {
  const { embeds, text, rule, post, dedupe } = ctx;
  if (/pokemoncenter\.(ca|co\.uk)/i.test(text) && (rule.params || {}).region !== "any")
    return { skipped: "non-us" };
  const sku = pcSku(text);
  if (!sku) return { skipped: "no-sku" };
  const p = rule.params || {};
  if (!keywordsOk(p, productText(embeds, ctx.content))) return { skipped: "keywords" };
  const gate = confirmGate(ctx, p, "pc:" + sku);
  if (gate) return { ...gate, sku };
  const src = (embeds && embeds[0]) || {};
  const title = (src.fields || []).find((f) => /product|item|title/i.test(f.name || ""))?.value
    || (src.title && !/checkout|success|carted/i.test(src.title) ? src.title : null)
    || "Pokémon Center";
  const clean = String(title).replace(/\[|\]\(.*?\)/g, "").slice(0, 240);
  const link = pcUrl(sku, clean);
  await post({
    embeds: [{
      title: clean, url: link,
      description: `${firstPrice(embeds, text) ? `**${firstPrice(embeds, text)}** · ` : ""}[View at Pokémon Center](${link})`,
      color: 0x35d0ba,
      image: firstImage(embeds) ? { url: firstImage(embeds) } : undefined,
      footer: { text: "PKMD · Pokémon Center US" },
    }],
  });
  return { posted: true, sku };
}

/* ---------------- walmart batching pipeline ---------------- */
/* Aggregate walmart links into ONE deduplicated embed per window.
   PID extraction from /ip/.../<digits>; title cleanup from md links or embed title. */

function walmartPid(url) {
  const m = String(url || "").match(/walmart\.com\/ip\/(?:[^/?#]*\/)?(\d{6,})/i);
  return m ? m[1] : null;
}

function productName(embeds) {
  for (const e of embeds || []) {
    const f = (e.fields || []).find((x) => /product|item|title|name/i.test(x.name || ""));
    if (f && f.value) return String(f.value).replace(/\[|\]\(.*?\)/g, "").trim();
    if (e.title && !/checkout|logs|carted|success|restock/i.test(e.title)) return e.title;
  }
  return null;
}

function walmartItems(text, embeds) {
  const out = [];
  const links = urlsIn(text).filter((u) => /walmart\.com\/ip\//i.test(u));
  const md = [...String(text || "").matchAll(/\[([^\]]{3,80})\]\((https?:\/\/[^)]+walmart\.com\/ip\/[^)]+)\)/gi)];
  const titled = new Map(md.map((m) => [m[2], m[1]]));
  for (const u of links) {
    const pid = walmartPid(u);
    if (!pid) continue;
    const t = titled.get(u) || productName(embeds) || "Walmart item";
    out.push({ pid, url: `https://www.walmart.com/ip/${pid}`, title: String(t).slice(0, 90) });
  }
  return out;
}

function reduceBatch(items) {
  const seen = new Set(); const uniq = [];
  for (const it of items) if (!seen.has(it.pid)) { seen.add(it.pid); uniq.push(it); }
  return uniq.slice(0, 20);
}

function walmartEmbed(items) {
  return {
    title: `Walmart · ${items.length} live link${items.length === 1 ? "" : "s"}`,
    description: items.map((it, i) => `**${i + 1}.** [${it.title}](${it.url})`).join("\n").slice(0, 3900),
    color: 0x0071dc,
    footer: { text: "PKMD · batched to keep the channel clean" },
  };
}

/* batching state lives in the router (per-rule buffers); handler just collects */
async function handleWalmart(ctx) {
  const p = ctx.rule.params || {};
  const ptext = productText(ctx.embeds, ctx.content);
  const mode = p.filter || "off";
  if (mode === "tcg" && !looksTCG(ptext)) return { skipped: "filter" };
  if (mode === "pokemon" && !looksPokemon(ptext)) return { skipped: "filter" };
  if (!keywordsOk(p, ptext)) return { skipped: "keywords" };
  const found = walmartItems(ctx.text, ctx.embeds);
  if (!found.length) return { skipped: "no-links" };
  const kept = [], gates = [];
  for (const it of found) {
    const gate = confirmGate(ctx, p, "wm:" + it.pid);
    if (gate) gates.push(gate); else kept.push(it);
  }
  if (!kept.length) return { ...gates[0], items: found.length };
  ctx.batch(kept); // router flushes on size/time
  return { batched: kept.length };
}

/* ---------------- keyword forward pipeline ---------------- */

function forwardMatch(text, params) {
  const kws = (params && params.keywords) || [];
  if (!kws.length) return true;
  const t = String(text || "").toLowerCase();
  const hit = (k) => t.includes(String(k).toLowerCase());
  return (params.mode === "all") ? kws.every(hit) : kws.some(hit);
}

async function handleForward(ctx) {
  if (!forwardMatch(ctx.text, ctx.rule.params)) return { skipped: "no-match" };
  const embeds = (ctx.embeds || []).slice(0, 4);
  if (!embeds.length && !ctx.content) return { skipped: "empty" };
  const key = "fw:" + require("crypto").createHash("sha1")
    .update(ctx.rule.id + "|" + ctx.text.slice(0, 400)).digest("hex").slice(0, 16);
  if (!ctx.dedupe(key)) return { skipped: "dupe" };
  await ctx.post({ content: ctx.content && !embeds.length ? ctx.content.slice(0, 1800) : undefined, embeds: embeds.length ? embeds : undefined });
  return { posted: true };
}

const HANDLERS = { amazon: handleAmazon, target: handleTarget, pc: handlePC, walmart: handleWalmart, forward: handleForward };

module.exports = {
  HANDLERS, allText, firstImage, firstPrice, urlsIn, looksPokemon, slugify,
  asinOf, amazonHostOk, affiliateUrl, amzLinks, looksTCG, fold, burstGate, burstFor, resetBursts, confirmGate, productText, keywordsOk,
  targetHostOk, targetTcin, targetUrl, pcSku, pcUrl,
  walmartPid, walmartItems, reduceBatch, walmartEmbed, forwardMatch,
};
