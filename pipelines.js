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

function looksPokemon(text) {
  return /pok[eé]mon|pkmn|\btcg\b|elite trainer|booster|\betb\b|prismatic|surging|scarlet|violet|151\b/i.test(text || "");
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

async function handleAmazon(ctx) {
  const { embeds, text, rule, post, dedupe } = ctx;
  const p = rule.params || {};
  if ((p.filter || "pokemon") !== "off" && !looksPokemon(text)) return { skipped: "filter" };
  const cand = urlsIn(text).filter(amazonHostOk);
  const asin = cand.map(asinOf).find(Boolean);
  if (!asin) return { skipped: "no-asin" };
  if (!dedupe("amz:" + asin)) return { skipped: "dupe" };
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
  if (!dedupe("pc:" + sku)) return { skipped: "dupe" };
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

function walmartItems(text, embeds) {
  const out = [];
  const links = urlsIn(text).filter((u) => /walmart\.com\/ip\//i.test(u));
  const md = [...String(text || "").matchAll(/\[([^\]]{3,80})\]\((https?:\/\/[^)]+walmart\.com\/ip\/[^)]+)\)/gi)];
  const titled = new Map(md.map((m) => [m[2], m[1]]));
  for (const u of links) {
    const pid = walmartPid(u);
    if (!pid) continue;
    const t = titled.get(u) || ((embeds && embeds[0] && embeds[0].title) || "Walmart item");
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
  const items = walmartItems(ctx.text, ctx.embeds).filter((it) => ctx.dedupe("wm:" + it.pid));
  if (!items.length) return { skipped: "no-links" };
  ctx.batch(items); // router flushes on size/time
  return { batched: items.length };
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

const HANDLERS = { amazon: handleAmazon, pc: handlePC, walmart: handleWalmart, forward: handleForward };

module.exports = {
  HANDLERS, allText, firstImage, firstPrice, urlsIn, looksPokemon, slugify,
  asinOf, amazonHostOk, affiliateUrl, amzLinks, pcSku, pcUrl,
  walmartPid, walmartItems, reduceBatch, walmartEmbed, forwardMatch,
};
