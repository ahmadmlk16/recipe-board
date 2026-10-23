# Recipe Board

A private recipe board for the household, hosted on Cloudflare Pages (free tier).

- **Recipes** (`/#recipes`): your saved recipes with ingredients, method, notes and nutrition per serving. Tick an ingredient and it goes on the grocery list; "Add all to list" adds the rest.
- **Ingredients** (`/#ingredients`): every ingredient your recipes use, grouped by supermarket aisle, with a chip for each recipe that needs it. Tap a chip to shop for that recipe, or tick the row to shop for all of them.
- **Grocery list** (`/#grocery`): what to buy, grouped by aisle, with amounts added up across recipes ("2 cup + 3 tbsp"). Tick items off in the store, add extras by hand, copy the list into a message.
- **Add a recipe** four ways: paste a **link** (reads the recipe data most sites publish, no AI needed), **paste text** from anywhere (AI structures it), **ask AI** to create one ("chicken karahi for 4, not too spicy"), or **write it** yourself. Every result opens in the editor first; nothing is saved until you press Save.
- **Logins**: the first account is created with a one-time setup key. Anyone logged in can add another person under Account. Everyone shares the same board.

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
  api/[[path]].js    "/api/*" JSON API
src/                 server code used by the functions
  api.js             all API endpoints
  auth.js            password hashing (PBKDF2), sessions, rate limiting
  db.js              D1 schema (auto-created on first request)
  recipes.js         recipe and grocery item shapes, validated on save
  ai.js              import from link, parse text, generate (Workers AI)
dev/server.mjs       local test server (Node 22+, no install needed)
test/                unit tests: node --test test/*.test.mjs
```

### Data model

Board data lives in one D1 table, `docs (coll, id, data JSON, updated_at)`:

| Collection | One row per | Notes |
| --- | --- | --- |
| `recipes` | recipe | `ingredients: [{qty, unit, item}]`, `steps`, `nutrition: {calories, protein, carbs, fat}` per serving, `tags`, `sourceUrl` |
| `grocery` | thing to buy | id is the normalized ingredient name, so "Eggs" from two recipes is one line; `sources` records which recipe (and which ingredient line) asked for how much |

### Planned: calorie tracker and Life Board

The food board is meant to become one board inside a bigger **Life Board**. It is set up for that:

- New boards add their own collections to the same `docs` table (for example `meals` for a food log, `tasks` for a Jira-style board). No schema migration is needed.
- Recipes already store nutrition per serving, so a calorie tracker can log "1.5 servings of Chicken karahi" and add up the day.
- Logins, sessions and the API router are shared, so a new board is a new set of routes in `src/` plus a new section in `public/`.

## Cloudflare settings

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
