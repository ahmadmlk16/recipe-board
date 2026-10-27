# Recipe Board

A private recipe board for the household. Runs on Cloudflare (Worker or Pages, free tier) or on a home server with Docker; see [Self-hosting on ZimaOS](docs/self-hosting.md).

- **Recipes** (`/#recipes`): your saved recipes with ingredients, method, notes and nutrition per serving. Tick an ingredient and it goes on the grocery list; "Add all to list" adds the rest.
- **Ingredients** (`/#ingredients`): every ingredient your recipes use, grouped by supermarket aisle, with a chip for each recipe that needs it. Tap a chip to shop for that recipe, or tick the row to shop for all of them.
- **Grocery list** (`/#grocery`): what to buy, grouped by aisle, with amounts added up across recipes ("2 cup + 3 tbsp"). Tick items off in the store, add extras by hand, copy the list into a message.
- **Add a recipe** five ways: take a **photo** of a cookbook page, card or handwriting (AI reads it, up to 3 pages), paste a **link** (reads the recipe data most sites publish, no AI needed), **paste text** from anywhere (AI structures it), **ask AI** to create one ("chicken karahi for 4, not too spicy"), or **write it** yourself. Every result opens in the editor first; nothing is saved until you press Save.
- **Filter** recipes by type (Breakfast, Dinner, …) with the chips under the search box; tap a tag on a recipe to search for it.
- **Servings**: the − / + buttons rescale every amount (and the grocery list) and remember the size you picked. Units step up as they grow (12 tsp → ¼ cup) and round to kitchen fractions. Amounts written inside the steps are not changed.
- **Parts**: a recipe can have parts ("## Marinade" in the editor, or "For the sauce:" in pasted text; AI keeps a recipe's parts). Each part gets its own heading and "Add part" button. **Split parts into linked recipes** turns them into their own recipes, linked back to the dish; a recipe can also be "made with" any other recipe (a dough, a chutney). Linked parts show inside the dish and scale with it.
- **Appearance** (Account): match the device, light or dark, plus five accent colours. Saved per device.
- **Logins**: the first account is created with a one-time setup key. Anyone logged in can add another person under Account. Everyone shares the same board. Optionally, a **Continue with Authentik** button (any OpenID Connect sign-in) logs people in with their home account; see [Sign in with Authentik](docs/self-hosting.md#sign-in-with-authentik).

## Branches

| Branch | Deploys to |
| --- | --- |
| `main` | Preview: `main.<project>.pages.dev` |
| `prod` | Live site (your custom domain) |

Work on `main`, check the preview, then open a pull request `main → prod` and merge it to go live.

## How it's built

No build step and no dependencies: plain HTML/CSS/JS plus Cloudflare Pages Functions.

```
public/              static files
  index.html         the board (recipes, ingredients, grocery list)
  login.html         log in / first-time setup
  assets/app.js      board UI
  assets/lib.js      ingredient parsing, aisles, amounts (shared with the server)
  assets/app.css     styles (light and dark)
functions/
  api/[[path]].js    "/api/*" JSON API (Pages)
src/                 server code
  worker.js          entry point when deployed as a Worker
  api.js             all API endpoints
  auth.js            password hashing (PBKDF2), sessions, rate limiting
  oidc.js            "Continue with Authentik" (OpenID Connect sign-in)
  db.js              D1 schema (auto-created on first request)
  recipes.js         recipe and grocery item shapes, validated on save
  ai.js              photo, import from link, parse text, generate (Workers AI)
server/              home-server runtime (Docker / ZimaOS), see docs/self-hosting.md
  main.mjs           HTTP server: static files, _headers, /api/*
  d1.mjs             D1-style database on Node's built-in SQLite
  ai.mjs             env.AI for Ollama / OpenAI-compatible, Anthropic, or Workers AI REST
  import-d1.mjs      loads a `wrangler d1 export` file
Dockerfile, docker-compose.yml   image and the ZimaOS app definition
wrangler.jsonc       Worker settings and bindings
dev/server.mjs       local test server (Node 22+, no install needed)
test/                unit tests: node --test test/*.test.mjs
```

### Data model

Board data lives in one D1 table, `docs (coll, id, data JSON, updated_at)`:

| Collection | One row per | Notes |
| --- | --- | --- |
| `recipes` | recipe | `ingredients: [{qty, unit, item, group?}]`, `steps` (a `"## Part"` entry starts a part), `scale` (chosen serving multiplier), `components` (ids of linked recipes it's made with), `nutrition: {calories, protein, carbs, fat}` per serving, `tags`, `sourceUrl` |
| `grocery` | thing to buy | id is the normalized ingredient name, so "Eggs" from two recipes is one line; `sources` records which recipe (and which ingredient line) asked for how much |

### Planned: calorie tracker and Life Board

The food board is meant to become one board inside a bigger **Life Board**. It is set up for that:

- New boards add their own collections to the same `docs` table (for example `meals` for a food log, `tasks` for a Jira-style board). No schema migration is needed.
- Recipes already store nutrition per serving, so a calorie tracker can log "1.5 servings of Chicken karahi" and add up the day.
- Logins, sessions and the API router are shared, so a new board is a new set of routes in `src/` plus a new section in `public/`.

## Home server (ZimaOS)

See [docs/self-hosting.md](docs/self-hosting.md): one Docker app with a SQLite file, Ollama on the GPU for AI, and Cloudflare Tunnel or Tailscale for the public address. Pushes to `prod` build a new image that the server picks up automatically.

## Cloudflare settings

The app deploys either as a **Worker** (the live setup) or as a **Pages** project. Same code; pick one.

### As a Worker (current)

`wrangler.jsonc` holds the settings, so there is little to click:

- **Settings → Build**: Git repository `ahmadmlk16/recipe-board`, production branch `prod`, build command empty, deploy command `npx wrangler deploy`.
- The D1 database `recipe-board-db` and the Workers AI binding come from `wrangler.jsonc`; the database is created on the first deploy.
- **Settings → Variables and Secrets**: add `SETUP_KEY` as a Secret (plus `AI_DAILY_LIMIT` / `AI_MODEL` / `AI_VISION_MODEL` if wanted).
- Branch pushes get preview URLs, but they share the production database.

### As a Pages project

**Create the project**: Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick this repo.

**Build settings**: Framework preset *None*, build command empty, **build output directory `public`**, production branch **`prod`**.

**Bindings** (Settings → Bindings), for both Production and Preview:

| Type | Variable name | Value |
| --- | --- | --- |
| D1 database | `DB` | `recipe-board-db` (production) / `recipe-board-db-preview` (preview) |
| Workers AI | `AI` | (no value needed) |

**Variables and secrets** (Settings → Variables and Secrets):

| Name | Type | Purpose |
| --- | --- | --- |
| `SETUP_KEY` | Secret | One-time key used to create the first account at `/login` |
| `AI_DAILY_LIMIT` | Text (optional) | AI requests per person per day, default 40. Keeps usage inside the free Workers AI allowance |
| `AI_MODEL` | Text (optional) | Workers AI model, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `AI_VISION_MODEL` | Text (optional) | Model that reads recipe photos, default `@cf/meta/llama-4-scout-17b-16e-instruct` |

Database tables are created automatically; there are no migrations to run. After changing bindings, redeploy (Deployments → ⋯ → Retry deployment) so they take effect.

**Custom domain**: Custom domains → Set up a custom domain. If the domain is bought through Cloudflare, DNS is set up for you.

**Cost**: Pages, D1 and Workers AI all have free tiers that a household board stays well inside. Importing from a link usually needs no AI at all.

## Run locally

```
node dev/server.mjs
# open http://localhost:8788  (setup key: dev-setup-key)
# MOCK_AI=1 node dev/server.mjs   answers AI requests with a canned recipe
npm test                          # unit tests
```

Local data is stored in `.dev-data/` (git-ignored).
