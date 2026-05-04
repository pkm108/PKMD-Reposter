# Pokemon Ping Sorter Bot

Watches one Discord channel for embedded restock pings and routes them to two destination channels based on the embed title:

| Embed title contains…               | Goes to            |
|-------------------------------------|--------------------|
| `Pokémon x Target` *(most common)* | **collab channel** |
| `Pokemon x Target`                  | **collab channel** |
| `Target x Pokémon`                  | **collab channel** |
| `Target x Pokemon`                  | **collab channel** |
| Anything else                       | **TCG channel** (default) |

Both spellings (`Pokémon` with the accent and `Pokemon` without) and both word orders are matched, case-insensitive. Default-to-TCG means you'll never miss a restock — even if the source bot posts something with an unfamiliar title, it lands in the TCG channel rather than getting dropped.

## 1. Create the bot

1. Go to https://discord.com/developers/applications → **New Application**
2. Under **Bot**, create a bot and copy the token.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
4. Under **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: `View Channels`, `Read Message History`, `Send Messages`, `Embed Links`, `Manage Webhooks`
   - Open the generated URL and add the bot to your server.

## 2. Get the channel IDs

In Discord: **Settings → Advanced → Developer Mode = ON**. Then right-click each channel → **Copy Channel ID**.

You need three channel IDs:
- Source channel (where Pokemon Deals & Alerts posts)
- TCG destination channel
- Collab destination channel

## 3. Configure

```bash
cp .env.example .env
# fill in DISCORD_TOKEN and the channel IDs
```

## 4. Run

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python bot.py
```

## 5. Test the rules without waiting for a restock

In any channel the bot can see, run:

```
!classify
```

It will pull the most recent embed from the source channel and tell you which bucket it landed in.

## Deploy to Railway

The repo is already Railway-ready: `Procfile`, `.python-version`, and `requirements.txt` are all set up. The bot runs as a **worker** process (no web port, no health checks).

### One-time setup

1. Push this folder to a **private** GitHub repo. The included `.gitignore` keeps `.env` out, so your token won't leak — but double-check that `.env` is not in the repo before pushing.
2. Go to https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway will start building. While it does, click the service → **Variables** tab and add:

   | Variable             | Value                              |
   |----------------------|------------------------------------|
   | `DISCORD_TOKEN`      | your bot token                     |
   | `SOURCE_CHANNEL_ID`  | source channel ID                  |
   | `TCG_CHANNEL_ID`     | TCG destination channel ID         |
   | `COLLAB_CHANNEL_ID`  | collab destination channel ID      |
   | `USE_WEBHOOKS`       | `true` (or `false`)                |

4. The first build will likely fail because the variables weren't set yet — once you've added them, hit **Deployments → Redeploy** (or push any commit) and it'll start cleanly.

### Verifying it works

- **Deployments → View Logs** should show `Logged in as <BotName>` and `Watching channel <id>`.
- When a ping fires in the source channel you'll see `Forwarded [tcg] '...' -> #channel-name` lines.
- If you see `Destination channel ... not found / not accessible`, the bot isn't in that server or doesn't have View Channel permission there.

### Updating the bot later

Just push to the GitHub repo — Railway auto-deploys on every push to the default branch. To roll back, use **Deployments → ⋯ → Redeploy** on an older deployment.

### Cost note

A Discord bot like this uses very little memory and CPU — it'll comfortably fit in Railway's free trial credits and the Hobby plan's monthly allowance. If you want to confirm pricing, check railway.app/pricing as the free tier terms have shifted a few times.

## Tweaking the rules

The collab match is one regex at the top of `bot.py`:

```python
COLLAB_RE = re.compile(
    r"\bpok[eé]mon\s*x\s*target\b|\btarget\s*x\s*pok[eé]mon\b",
    re.IGNORECASE,
)
```

`pok[eé]mon` matches both `Pokemon` and `Pokémon`. Add more `|`-separated patterns if you want other things routed to the collab channel — e.g. `|\bpok[eé]mon\s*center\b` to also catch Pokémon Center exclusives.

If you ever want a third destination (apparel, plushies, etc.), turn `classify_embed` into a chain of checks and add another channel ID to `.env`.

## Webhook vs. bot send

With `USE_WEBHOOKS=true` (default), forwarded pings show up wearing the original bot's name and pikachu avatar — they look identical to the source. Set it to `false` to have everything posted under your bot's identity instead. Webhook mode requires the **Manage Webhooks** permission in the destination channels.
