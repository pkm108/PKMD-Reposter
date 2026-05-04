"""
Pokemon Ping Sorter Bot
-----------------------
Watches a source channel for embedded pings (e.g. from Pokemon Deals & Alerts),
classifies each embed as either a "Pokemon x Target" collab item or a regular
TCG product, and forwards it to the matching destination channel.
"""

import os
import re
import logging

import discord
from discord.ext import commands
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

load_dotenv()

TOKEN              = os.getenv("DISCORD_TOKEN")
SOURCE_CHANNEL_ID  = int(os.getenv("SOURCE_CHANNEL_ID", "0"))
TCG_CHANNEL_ID     = int(os.getenv("TCG_CHANNEL_ID", "0"))
COLLAB_CHANNEL_ID  = int(os.getenv("COLLAB_CHANNEL_ID", "0"))

# Use webhooks so the forwarded message preserves the original bot's
# username + avatar. Set to "false" to send as your own bot instead.
USE_WEBHOOKS = os.getenv("USE_WEBHOOKS", "true").lower() == "true"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("ping-sorter")

# ---------------------------------------------------------------------------
# Classification rules
# ---------------------------------------------------------------------------
# Binary split: anything whose title says "Pokemon x Target" / "Pokémon x
# Target" (or the reverse word order, with or without the accent) is a
# collab item. Everything else defaults to the TCG channel.
#
# pok[eé]mon  -> matches both "Pokemon" and "Pokémon"
# \s*x\s*     -> tolerant of spacing around the x
# re.IGNORECASE handles capitalisation

COLLAB_RE = re.compile(
    r"\bpok[eé]mon\s*x\s*target\b|\btarget\s*x\s*pok[eé]mon\b",
    re.IGNORECASE,
)


def classify_embed(embed: discord.Embed) -> str:
    """Return 'collab' if the title is a Pokemon x Target item, else 'tcg'."""
    title = embed.title or ""
    if COLLAB_RE.search(title):
        return "collab"
    return "tcg"


# ---------------------------------------------------------------------------
# Bot
# ---------------------------------------------------------------------------

intents = discord.Intents.default()
intents.message_content = True   # required so we can also forward message.content

bot = commands.Bot(command_prefix="!", intents=intents)

# Cache of channel_id -> webhook so we don't recreate one every message.
_webhook_cache: dict[int, discord.Webhook] = {}


async def get_or_create_webhook(channel: discord.TextChannel) -> discord.Webhook:
    if channel.id in _webhook_cache:
        return _webhook_cache[channel.id]

    hooks = await channel.webhooks()
    hook = discord.utils.get(hooks, name="PingSorter")
    if hook is None:
        hook = await channel.create_webhook(name="PingSorter")
    _webhook_cache[channel.id] = hook
    return hook


async def forward(message: discord.Message, embed: discord.Embed, dest: discord.TextChannel):
    """Re-send an embed to the destination channel."""
    if USE_WEBHOOKS:
        try:
            hook = await get_or_create_webhook(dest)
            await hook.send(
                content=message.content or None,
                embed=embed,
                username=message.author.display_name,
                avatar_url=message.author.display_avatar.url,
                allowed_mentions=discord.AllowedMentions.none(),
            )
            return
        except discord.Forbidden:
            log.warning("No webhook permission in #%s, falling back to bot send", dest.name)
        except discord.HTTPException as e:
            log.warning("Webhook send failed (%s), falling back to bot send", e)

    await dest.send(
        content=message.content or None,
        embed=embed,
        allowed_mentions=discord.AllowedMentions.none(),
    )


@bot.event
async def on_ready():
    log.info("Logged in as %s (id=%s)", bot.user, bot.user.id)
    log.info("Watching channel %s", SOURCE_CHANNEL_ID)


@bot.event
async def on_message(message: discord.Message):
    # Let the commands framework see every message first, otherwise
    # overriding on_message silently disables prefix commands like !classify.
    await bot.process_commands(message)

    # Only act on the source channel
    if message.channel.id != SOURCE_CHANNEL_ID:
        return
    # Never loop on our own forwards
    if message.author.id == bot.user.id:
        return
    if not message.embeds:
        return

    for embed in message.embeds:
        category = classify_embed(embed)
        dest_id = COLLAB_CHANNEL_ID if category == "collab" else TCG_CHANNEL_ID

        dest = bot.get_channel(dest_id)
        if dest is None:
            log.warning("Destination channel %s not found / not accessible", dest_id)
            continue

        try:
            await forward(message, embed, dest)
            log.info("Forwarded [%s] %r -> #%s", category, embed.title, dest.name)
        except Exception as e:                       # noqa: BLE001
            log.exception("Failed to forward embed: %s", e)


# ---------------------------------------------------------------------------
# Manual debug command — type !classify in any channel to test the rules
# against the most recent embed in the source channel.
# ---------------------------------------------------------------------------

@bot.command(name="classify")
async def classify_cmd(ctx: commands.Context):
    src = bot.get_channel(SOURCE_CHANNEL_ID)
    if not src:
        await ctx.reply("Source channel not found.")
        return
    async for msg in src.history(limit=20):
        if msg.embeds:
            cat = classify_embed(msg.embeds[0])
            await ctx.reply(f"Most recent embed: **{msg.embeds[0].title}** -> `{cat}`")
            return
    await ctx.reply("No recent embeds found.")


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN missing — copy .env.example to .env and fill it in.")
    bot.run(TOKEN)
