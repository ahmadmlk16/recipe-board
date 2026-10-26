# Self-hosting on ZimaOS

Recipe Board runs on a home server as a Docker app, with the same features it
has on Cloudflare. What replaces each Cloudflare piece:

| On Cloudflare | On the home server |
| --- | --- |
| Worker + static assets | `app` container (`server/main.mjs`), serves `public/` with `public/_headers` |
| D1 database | SQLite file at `/DATA/AppData/recipe-board/data/recipe-board.sqlite` |
| Workers AI | `ollama` container on the GPU, model `qwen2.5vl:7b` (reads photos and text) |
| `*.workers.dev` / custom domain, HTTPS | `tunnel` container (Cloudflare Tunnel), or Tailscale |
| Workers Builds (push to `prod` deploys) | GitHub Actions builds the image and calls a deploy webhook; the shared Deploy app (Watchtower, in the `ahmadmlk16/home-server` repo) swaps it in, with a 5-minute check as backup |
| Variables and Secrets | `environment:` in `docker-compose.yml` |

The Cloudflare code path still works, so the Worker can keep running until the
home server is ready.

## 1. Before you start

- ZimaOS installed, with the NVIDIA driver working (the RTX 3060 should show
  under Settings → hardware / GPU). Ollama falls back to the CPU without it,
  which works but reads a photo in minutes instead of seconds.
- The image is built by GitHub Actions on every push to `main` and `prod`
  (`.github/workflows/docker.yml`). After the first build, open
  github.com/ahmadmlk16?tab=packages → `recipe-board` → Package settings and
  set visibility to **Public**, so ZimaOS can pull it without a login.
  (Until a push to `prod`, only the `main` tag exists: use
  `ghcr.io/ahmadmlk16/recipe-board:main` in the compose file to try it.)

## 2. Public address (pick one)

**Cloudflare Tunnel** (anyone can open the site from anywhere, nothing opened
on your router). It needs a domain on Cloudflare; a `workers.dev` address
cannot point at a tunnel.

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel →
   Cloudflared. Name it `recipe-board`. Copy the token from the install command.
2. Public hostname: e.g. `recipes.yourdomain.com`, service `HTTP`, URL `app:8788`.
3. Paste the token into `TUNNEL_TOKEN` in `docker-compose.yml`.

**Tailscale** (only your own devices, each with the Tailscale app). Install
Tailscale from the ZimaOS App Store, delete the `tunnel` service from the
compose file, remove `TRUST_PROXY`, and open `http://<zimaos-tailscale-name>:8788`.

## 3. Install the app

1. In `docker-compose.yml`, set `SETUP_KEY` (any long random text) and
   `TUNNEL_TOKEN`.
2. ZimaOS → App Store → **+** → Install a customized app → Import → paste the
   file → Install.
3. The `ollama-pull` container downloads the model once (about 6 GB) and stops.
   Check its log in the ZimaOS app view; AI features work once it says `success`.
4. Open `http://<zimaos-ip>:8788`. Don't create an account yet if you are
   moving existing data (next step).

## 4. Move the data from Cloudflare D1

On your computer (needs Node):

```
npx wrangler login
npx wrangler d1 export recipe-board-db --remote --output=d1-backup.sql
```

Copy `d1-backup.sql` into `/DATA/AppData/recipe-board/data/` (ZimaOS Files app),
then in the ZimaOS terminal (or SSH):

```
docker exec recipe-board node server/import-d1.mjs /data/d1-backup.sql
docker restart recipe-board
```

Everyone's logins, recipes and the grocery list come across; people only need
to log in again. The import refuses to run if the new database already has
users or recipes.

## 5. Switch over

Once the home site works through its public address, stop using the Worker
(Cloudflare → Workers & Pages → recipe-board → Settings → delete, or just
disconnect the Git build). Keep the D1 export as a backup.

## 6. Deploys (webhook)

Changes go live the same way as on Cloudflare: work on `main`, merge
`main → prod`. GitHub Actions then tests, builds the image, and calls the
server's deploy webhook, which pulls the image and restarts the app (data is
untouched; it lives in the volume). Usually live a minute or two after merging.

The webhook is served by a separate **Deploy** app, shared by every
self-hosted app on the server, so removing one app never stops deploys for
the others. It updates any container labelled
`com.centurylinklabs.watchtower.enable: "true"` and restarts only the ones
whose image changed.

One-time setup:

1. Make up a long random token and put it in `WATCHTOWER_HTTP_API_TOKEN` in
   `deploy/docker-compose.yml` from the `ahmadmlk16/home-server` repo, then install that file as its own ZimaOS app
   (App Store → **+** → Install a customized app → Import).
2. In the Cloudflare tunnel, add a public hostname, e.g.
   `deploy.yourdomain.com` → `HTTP` → `<zimaos-ip>:8789`.
3. GitHub → repo → Settings → Secrets and variables → Actions → add
   `DEPLOY_URL` = `https://deploy.yourdomain.com` and `DEPLOY_TOKEN` = the token.

A future app joins as described in the `home-server` repo's README: the
label in its compose file, the shared workflow, and the same two secrets.

Without the webhook (for example on Tailscale only), the server still notices
the new image within 5 minutes. To roll back, set the app's image to an older
`ghcr.io/ahmadmlk16/recipe-board:sha-<commit>` tag.

## Backups

Everything lives in `/DATA/AppData/recipe-board/data`. Copy that folder (with
the app stopped, or copy `recipe-board.sqlite` plus its `-wal` file) to another
drive or cloud storage.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `SETUP_KEY` | | One-time key to create the first login |
| `PORT` | `8788` | Port inside the container |
| `DATA_DIR` | `/data` | Where the SQLite file lives |
| `TRUST_PROXY` | off | Set to `1` behind Cloudflare Tunnel or another proxy so client IPs and HTTPS are seen correctly |
| `AI_PROVIDER` | `cloudflare` if `CF_*` set, else off | `openai` (Ollama, OpenAI, Gemini, OpenRouter), `anthropic`, `cloudflare`, or `none` |
| `AI_BASE_URL` | OpenAI / Anthropic | e.g. `http://ollama:11434/v1` |
| `AI_API_KEY` | | Not needed for Ollama |
| `AI_MODEL` | | Text model (structuring, "ask AI") |
| `AI_VISION_MODEL` | | Photo reading model |
| `AI_VISION_FALLBACK_MODEL` | | Optional second photo model if the first fails |
| `AI_TIMEOUT_SECONDS` | `50` | How long one photo may take |
| `AI_DAILY_LIMIT` | `40` | AI requests per person per day |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | | Only for `AI_PROVIDER=cloudflare` (Workers AI over its API) |

To try a different local model, run `docker exec recipe-board-ollama ollama pull <model>`
and change `AI_MODEL` / `AI_VISION_MODEL`. Larger models (for example
`gemma3:12b`) read handwriting better but need most of the 3060's memory.

### When the AI features fail

The app log (`docker logs recipe-board`) says what went wrong. Right after
start it prints `AI ready: ...` or `AI check failed: ...`, and every failed
request logs `AI error (...)` with the reason from the AI server. The usual ones:

- `can't reach http://ollama:11434: ENOTFOUND` or `ECONNREFUSED`: the `ollama`
  container isn't running. Check `docker ps -a` and `docker logs recipe-board-ollama`.
- `model qwen2.5vl:7b not found`: the download never finished. Run
  `docker exec recipe-board-ollama ollama pull qwen2.5vl:7b`.
- `500: ... memory`: the model doesn't fit. Use a smaller model or check the GPU.

## Run it without Docker

```
SETUP_KEY=... AI_PROVIDER=openai AI_BASE_URL=http://localhost:11434/v1 \
AI_MODEL=qwen2.5vl:7b AI_VISION_MODEL=qwen2.5vl:7b node server/main.mjs
```

Data goes to `.data/` unless `DATA_DIR` is set.
