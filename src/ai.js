// Recipe import, parsing and generation.
//
// Importing from a link first reads the schema.org Recipe data most recipe
// sites embed in the page, which costs nothing. Only when that is missing,
// and for pasted text or "make me a recipe" prompts, do we call Workers AI
// (free daily allowance on Cloudflare). Every result is a draft: the app
// opens it in the editor and nothing is saved until the person saves it.
import { parseIngredients } from '../public/assets/lib.js';
import { CATEGORIES } from './recipes.js';
import { fail, str } from './util.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_PAGE = 2_000_000;
const MAX_TEXT = 12_000;

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    minutes: { type: 'number' },
    servings: { type: 'number' },
    ingredients: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    nutrition: {
      type: 'object',
      properties: {
        calories: { type: 'number' },
        protein: { type: 'number' },
        carbs: { type: 'number' },
        fat: { type: 'number' },
      },
    },
  },
  required: ['name', 'ingredients', 'steps'],
};

const SYSTEM = `You turn recipes into structured JSON for a home cook's recipe board.
Rules:
- "ingredients": one string per ingredient, quantity first, e.g. "2 cups basmati rice", "3 cloves garlic, minced", "salt to taste". Use numbers, not words, for quantities.
- "steps": short imperative steps in order, without numbering.
- "category": one of ${CATEGORIES.join(', ')}.
- "minutes": total time; "servings": how many people it feeds.
- "nutrition": your best estimate PER SERVING: calories (kcal), protein, carbs and fat in grams.
- "tags": up to 4 short lowercase tags such as cuisine or diet.
- "notes": one or two sentences of useful tips, or an empty string.
Reply with JSON only.`;

/* ------------------------------ schema.org ------------------------------- */

function isRecipe(node) {
  const t = node?.['@type'];
  return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
}

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (isRecipe(node)) return node;
  return findRecipe(node['@graph'], depth + 1) || findRecipe(node.mainEntity, depth + 1);
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ISO 8601 durations like "PT1H30M" -> 90
export function isoMinutes(value) {
  const m = String(value || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const total = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return total || null;
}

function firstNumber(value) {
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) {
    const m = String(v ?? '').match(/\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

function steps(instructions) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      // Some sites put every step in one string.
      decodeEntities(node)
        .split(/(?:\r?\n|(?<=\.)\s+(?=\d+[.)]\s))/)
        .map((s) => s.replace(/^\d+[.)]\s*/, '').trim())
        .filter(Boolean)
        .forEach((s) => out.push(s));
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node.itemListElement) {
      walk(node.itemListElement);
    } else if (node.text || node.name) {
      out.push(decodeEntities(node.text || node.name));
    }
  };
  walk(instructions);
  return out;
}

function imageUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return imageUrl(image[0]);
  return image.url || '';
}

function category(value) {
  const text = (Array.isArray(value) ? value.join(' ') : String(value || '')).toLowerCase();
  return CATEGORIES.find((c) => text.includes(c.toLowerCase())) || (/main|entree|curry/.test(text) ? 'Dinner' : 'Other');
}

export function recipeFromSchema(r, sourceUrl) {
  const n = r.nutrition || {};
  return {
    name: decodeEntities(r.name || 'Imported recipe'),
    category: category(r.recipeCategory),
    minutes: isoMinutes(r.totalTime) ?? ((isoMinutes(r.prepTime) || 0) + (isoMinutes(r.cookTime) || 0) || null),
    servings: firstNumber(r.recipeYield),
    ingredients: parseIngredients((r.recipeIngredient || r.ingredients || []).map(decodeEntities).join('\n')),
    steps: steps(r.recipeInstructions),
    notes: '',
    sourceUrl,
    image: imageUrl(r.image),
    nutrition: {
      calories: firstNumber(n.calories),
      protein: firstNumber(n.proteinContent),
      carbs: firstNumber(n.carbohydrateContent),
      fat: firstNumber(n.fatContent),
    },
    tags: [],
  };
}

export function schemaRecipeFromHtml(html) {
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const found = findRecipe(JSON.parse(m[1].trim()));
      if (found) return found;
    } catch {
      // Ignore broken blocks; keep looking.
    }
  }
  return null;
}

function pageText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n'),
  ).slice(0, MAX_TEXT);
}

/* -------------------------------- Workers AI ------------------------------ */

function fromAi(data, sourceUrl = '') {
  if (!data || typeof data !== 'object') fail(502, 'The AI did not return a recipe. Try rephrasing.');
  const n = data.nutrition || {};
  return {
    name: str(data.name, 150) || 'Untitled recipe',
    category: CATEGORIES.includes(data.category) ? data.category : 'Other',
    minutes: Number(data.minutes) || null,
    servings: Number(data.servings) || null,
    ingredients: parseIngredients((Array.isArray(data.ingredients) ? data.ingredients : []).join('\n')),
    steps: (Array.isArray(data.steps) ? data.steps : []).map((s) => str(s, 2000)).filter(Boolean),
    notes: str(data.notes, 2000),
    sourceUrl,
    image: '',
    nutrition: { calories: Number(n.calories) || null, protein: Number(n.protein) || null, carbs: Number(n.carbs) || null, fat: Number(n.fat) || null },
    nutritionEstimated: true,
    tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 4).map((t) => str(t, 30).toLowerCase()),
  };
}

async function askAi(env, userPrompt) {
  if (!env.AI) fail(503, 'AI is not connected yet. Add the Workers AI binding named AI in Cloudflare.');
  let result;
  try {
    result = await env.AI.run(env.AI_MODEL || DEFAULT_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_schema', json_schema: RECIPE_SCHEMA },
      max_tokens: 2500,
      temperature: 0.4,
    });
  } catch (err) {
    console.error('Workers AI error', err);
    const msg = String(err?.message || '');
    if (/limit|quota|neuron|429/i.test(msg)) fail(429, "Today's free AI allowance is used up. It resets at midnight UTC.");
    fail(502, 'The AI could not answer just now. Try again in a minute.');
  }
  let data = result?.response ?? result;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1));
    } catch {
      fail(502, 'The AI reply could not be read. Try again.');
    }
  }
  return data;
}

/* --------------------------------- Actions -------------------------------- */

export async function importFromUrl(env, rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    fail(400, 'Please paste a full link that starts with https://');
  }
  let res;
  try {
    res = await fetch(url.href, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RecipeBoard/1.0; personal recipe import)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(502, 'That site did not answer. Check the link or paste the recipe text instead.');
  }
  if (!res.ok) fail(502, `That site refused the request (${res.status}). Paste the recipe text instead.`);
  const html = (await res.text()).slice(0, MAX_PAGE);

  const schema = schemaRecipeFromHtml(html);
  if (schema) {
    const recipe = recipeFromSchema(schema, url.href);
    if (recipe.ingredients.length) return { recipe, method: 'page' };
  }
  const text = pageText(html);
  if (text.length < 200) fail(422, 'No recipe was found on that page. Paste the recipe text instead.');
  const data = await askAi(env, `Extract the recipe from this web page text. If it has several, use the main one.\n\n${text}`);
  return { recipe: fromAi(data, url.href), method: 'ai' };
}

export async function parseText(env, text) {
  const clean = str(text, MAX_TEXT);
  if (clean.length < 20) fail(400, 'Paste the whole recipe: its ingredients and steps.');
  const data = await askAi(env, `Structure this recipe exactly as written. Keep the author's quantities.\n\n${clean}`);
  return { recipe: fromAi(data), method: 'ai' };
}

export async function generate(env, prompt) {
  const clean = str(prompt, 1000);
  if (clean.length < 3) fail(400, 'Describe what you would like to cook.');
  const data = await askAi(
    env,
    `Write one reliable, home-kitchen recipe for this request: ${clean}\nUse ingredients found in a normal supermarket.`,
  );
  return { recipe: fromAi(data), method: 'ai' };
}
