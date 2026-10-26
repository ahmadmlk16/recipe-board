// Recipe import, parsing and generation.
//
// Importing from a link first reads the schema.org Recipe data most recipe
// sites embed in the page, which costs nothing. Only when that is missing,
// and for pasted text or "make me a recipe" prompts, do we call Workers AI
// (free daily allowance on Cloudflare). Every result is a draft: the app
// opens it in the editor and nothing is saved until the person saves it.
import { parseIngredients, parseSteps } from '../public/assets/lib.js';
import { CATEGORIES } from './recipes.js';
import { fail, str } from './util.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// Reads photos of printed or handwritten recipes.
const DEFAULT_VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 2_500_000; // one data URL, about 1.8 MB of JPEG
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
- If the recipe has separate parts (for example a marinade, a sauce, a dough, a raita), put a line "## Part name" before that part's ingredients in "ingredients" and before that part's steps in "steps". Use the same part names in both lists. Leave parts out for simple recipes.
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
      if (node.name) out.push(`## ${decodeEntities(node.name)}`);
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
    steps: parseSteps((Array.isArray(data.steps) ? data.steps : []).map((s) => str(s, 2000).replace(/\n/g, ' ')).join('\n')),
    notes: str(data.notes, 2000),
    sourceUrl,
    image: '',
    nutrition: { calories: Number(n.calories) || null, protein: Number(n.protein) || null, carbs: Number(n.carbs) || null, fat: Number(n.fat) || null },
    nutritionEstimated: true,
    tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 4).map((t) => str(t, 30).toLowerCase()),
  };
}

const isAllowanceError = (err) => /limit|quota|neuron|429/i.test(String(err?.message || ''));

async function askAi(env, userPrompt) {
  if (!env.AI) fail(503, 'AI is not connected yet. Add the Workers AI binding named AI in Cloudflare, or set AI_PROVIDER on the home server.');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt },
  ];
  let result;
  try {
    result = await env.AI.run(model, {
      messages,
      response_format: { type: 'json_schema', json_schema: RECIPE_SCHEMA },
      max_tokens: 3000,
      temperature: 0.3,
    });
  } catch (err) {
    console.error(`AI error (${model}, JSON mode):`, err?.message || err);
    if (isAllowanceError(err)) fail(429, "Today's free AI allowance is used up. It resets at midnight UTC.");
    // Some models refuse JSON mode for some inputs; ask again for plain JSON text.
    try {
      result = await env.AI.run(model, { messages, max_tokens: 3000, temperature: 0.3 });
    } catch (err2) {
      console.error(`AI error (${model}):`, err2?.message || err2);
      if (isAllowanceError(err2)) fail(429, "Today's free AI allowance is used up. It resets at midnight UTC.");
      fail(502, `The AI could not answer just now. Try again in a minute. (Details: ${String(err2?.message || err2).slice(0, 200)})`);
    }
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

export async function readPhotos(env, images) {
  if (!env.AI) fail(503, 'AI is not connected yet. Add the Workers AI binding named AI in Cloudflare, or set AI_PROVIDER on the home server.');
  const list = (Array.isArray(images) ? images : []).filter(
    (u) => typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u),
  );
  if (!list.length) fail(400, 'Add a photo of the recipe first.');
  if (list.length > MAX_IMAGES) fail(400, `Use at most ${MAX_IMAGES} photos at a time.`);
  if (list.some((u) => u.length > MAX_IMAGE_CHARS)) fail(413, 'One of the photos is too large. Try again; the app shrinks photos before sending.');
  // Two steps: a vision model copies out the text of each page, then the text
  // model structures it the same way pasted text is structured.
  const pages = [];
  for (const url of list) pages.push(await transcribe(env, url));
  const text = pages.join('\n\n').slice(0, MAX_TEXT);
  const data = await askAi(
    env,
    'This text was copied from a photo of a recipe (a cookbook page, a printout or a handwritten card). ' +
      'Structure it exactly as written, keeping the quantities. Ignore page numbers and text from other recipes. ' +
      'If a word looks garbled, make your best guess and mention it in "notes".\n\n' + text,
  );
  return { recipe: fromAi(data), method: 'photo' };
}

const TRANSCRIBE_PROMPT =
  'Copy out all the text of the recipe in this photo, exactly as written: the title, servings, every ingredient line with its amount, ' +
  'and every step. Keep headings like "For the sauce". Reply with the text only.';

/** Copy the text out of one photo, trying a few vision models in turn. */
async function transcribe(env, dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const withImageUrl = {
    messages: [{ role: 'user', content: [{ type: 'text', text: TRANSCRIBE_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    max_tokens: 2048,
    temperature: 0,
  };
  const attempts = [
    [env.AI_VISION_MODEL || DEFAULT_VISION_MODEL, withImageUrl],
    ['@cf/meta/llama-3.2-11b-vision-instruct', { messages: [{ role: 'user', content: TRANSCRIBE_PROMPT }], image: base64, max_tokens: 2048, temperature: 0 }],
    ['@cf/google/gemma-3-12b-it', withImageUrl],
  ];
  const errors = [];
  for (const [model, input] of attempts) {
    try {
      let result;
      try {
        result = await runWithTimeout(env, model, input);
      } catch (err) {
        // Meta's vision model asks each account to accept its licence once.
        if (!/agree|licen[cs]e/i.test(String(err?.message || ''))) throw err;
        await env.AI.run(model, { prompt: 'agree' });
        result = await runWithTimeout(env, model, input);
      }
      const text = typeof result?.response === 'string' ? result.response : typeof result === 'string' ? result : '';
      if (text.trim().length >= 20) return text.trim();
      errors.push(`${shortModel(model)}: no text`);
    } catch (err) {
      console.error('Vision error', model, err);
      const msg = String(err?.message || err);
      if (/quota|neuron|429|daily/i.test(msg)) fail(429, "Today's free AI allowance is used up. It resets at midnight UTC.");
      errors.push(`${shortModel(model)}: ${msg.slice(0, 140)}`);
    }
  }
  fail(502, `The AI could not read that photo. Try a closer, well-lit shot, or paste the text instead. (Details: ${errors.join(' | ')})`);
}

// AI_TIMEOUT_SECONDS gives slow home-server models longer than Workers AI needs.
function runWithTimeout(env, model, input, ms = (Number(env.AI_TIMEOUT_SECONDS) || 50) * 1000) {
  let timer;
  return Promise.race([
    env.AI.run(model, input).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), ms))),
  ]);
}

const shortModel = (m) => m.split('/').pop();

/* -------------------------------- AI status ------------------------------- */

// For the status dot in the header. The app asks every minute, so the result
// is kept for 30 seconds and every caller in that window shares one check.
// Home-server providers can check() their AI server; the Workers AI binding
// can't be checked without spending allowance, so it counts as ready.
const STATUS_TTL = 30_000;
let lastStatus = null;
let pendingStatus = null;

export async function aiStatus(env) {
  if (!env.AI) return { state: 'off', detail: 'AI is not set up.' };
  if (lastStatus && Date.now() - lastStatus.at < STATUS_TTL) return lastStatus.status;
  pendingStatus ||= (async () => {
    let status;
    try {
      await env.AI.check?.();
      status = { state: 'ready', detail: env.AI_MODEL ? `${env.AI_MODEL} is ready.` : 'AI is ready.' };
    } catch (err) {
      status = { state: 'down', detail: String(err?.message || err).slice(0, 300) };
    }
    lastStatus = { at: Date.now(), status };
    pendingStatus = null;
    return status;
  })();
  return pendingStatus;
}

// Same for the voice that reads aloud (env.TTS, server/tts.mjs). Without
// one, or while it is down, the browser's own voice reads instead.
let lastVoice = null;
let pendingVoice = null;

export async function voiceStatus(env) {
  if (!env.TTS) return { state: 'off', detail: "No voice server is set up, so your browser's voice reads aloud." };
  if (lastVoice && Date.now() - lastVoice.at < STATUS_TTL) return lastVoice.status;
  pendingVoice ||= (async () => {
    let status;
    try {
      await env.TTS.check?.();
      status = { state: 'ready', detail: 'Index-TTS is ready.' };
    } catch (err) {
      status = { state: 'down', detail: `${String(err?.message || err).slice(0, 300)}. Your browser's voice reads aloud until it's back.` };
    }
    lastVoice = { at: Date.now(), status };
    pendingVoice = null;
    return status;
  })();
  return pendingVoice;
}
