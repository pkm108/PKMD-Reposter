# PKMD Reposter

One bot replacing four: **amazon** (Refract deal reposts w/ `stocktcg-20` tag), **pc**
(Valor → Pokémon Center US product links), **walmart** (link batching, deduped), and
**forward** (keyword embed forwarding). One gateway connection → ONE Message Content
intent review per year instead of four.

## Setup (Railway)
1. New service from this repo. Attach a **volume at `/data`**.
2. Env: `DISCORD_TOKEN`, `GUILD_ID`, `DB_PATH=/data/reposter.db`, `DRY_RUN=1`,
   `NODE_OPTIONS=--max-old-space-size=256`. Optional: `AMAZON_TAG`, `ROUTES_JSON` (see .env.example).
3. Bot needs **Message Content** ON in the portal, and in the server: View Channel +
   Read History on source channels, Send Messages + Embed Links on targets.

## Routes
`/route add kind:<amazon|target|pc|walmart|forward> source:#feed target:#public [keywords] [filter] [confirm] [cooldown] [window]`
· `/route list` · `/route toggle id` · `/route remove id` · `/reposter` (status/stats).
Multiple routes may share one source channel (fan-out). Rules live in SQLite on the volume.

**Amazon, Target & Walmart route params** (keywords/confirm also apply to pc): `filter` = `tcg` (default: Pokemon TCG products only) | `pokemon`
(any Pokemon) | `off`. `confirm:N` posts an item only after N pings for the same ASIN within
`window` minutes (default 10) — for checkout/monitor feeds where 1-2 pings mean instant sellout.
After a confirmed post the ASIN is muted for `cooldown` minutes (default 60). Example:
`/route add kind:amazon source:#monitor-feed target:#restock-alerts confirm:5 cooldown:60`
Target routes read Refract checkout embeds, extract the TCIN from `/p/~/-/A-<TCIN>` links,
and repost as branded `https://www.target.com/p/pkmd/A-<TCIN>` (override the slug with `slug`
in ROUTES_JSON if ever needed). (To change an existing route's params: `/route remove` then re-add.)

## Cutover playbook (zero-risk)
1. Deploy with `DRY_RUN=1`; add routes mirroring the old bots.
2. Watch logs: every `[dry]` line is a post the old bots should also be making. Compare for a day.
3. Flip `DRY_RUN=0`, shut old bot processes down (Railway), keep their apps but toggle
   Message Content **off** on each — no intents ⇒ no review needed for them.
4. Keep the surviving application's intent review submitted/current (see below).

## Intent review
This app needs **Message Content only** (Presence/Members off). Use-case text + evidence
gallery links: see the Drops & Deals admin panel → Evidence galleries, and /privacy + /terms
on the app domain. Reviews renew annually; the bot keeps working while a review is pending.
