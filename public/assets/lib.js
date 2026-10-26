// Pure helpers: parsing ingredient lines, naming, grouping and quantities.
// Kept free of DOM code so they can be tested with `node --test`.

const FRACTIONS = { "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };

const UNITS = {
  cup: "cup", cups: "cup", c: "cup",
  tbsp: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", T: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", t: "tsp",
  g: "g", gram: "g", grams: "g", kg: "kg",
  ml: "ml", l: "l", liter: "l", litre: "l", liters: "l", litres: "l",
  oz: "oz", ounce: "oz", ounces: "oz", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  pinch: "pinch", clove: "clove", cloves: "clove", can: "can", cans: "can",
  slice: "slice", slices: "slice", bunch: "bunch", handful: "handful",
  stick: "stick", sticks: "stick", packet: "packet", packets: "packet",
  piece: "piece", pieces: "piece", sprig: "sprig", sprigs: "sprig",
  inch: "inch", inches: "inch", dozen: "dozen", head: "head", heads: "head",
};

export const AISLES = [
  ["produce", "Produce"],
  ["meat", "Meat & fish"],
  ["dairy", "Dairy & eggs"],
  ["bakery", "Bread & bakery"],
  ["pantry", "Pantry"],
  ["spices", "Spices, oils & baking"],
  ["frozen", "Frozen"],
  ["other", "Other"],
];

// Checked in this order, so "black pepper" lands in spices before produce sees "pepper".
const AISLE_WORDS = [
  ["frozen", ["frozen", "ice cream", "peas"]],
  ["spices", ["salt", "black pepper", "cumin", "turmeric", "paprika", "masala", "garam masala", "cinnamon",
    "cardamom", "oil", "vinegar", "oregano", "thyme", "nutmeg", "powder", "spice", "bay leaf", "bay leaves",
    "chili flakes", "pepper flakes", "baking soda", "yeast", "vanilla", "cornstarch", "cocoa", "seed"]],
  ["pantry", ["flour", "sugar", "rice", "pasta", "spaghetti", "noodle", "lentil", "dal", "daal", "bean",
    "chickpea", "oat", "honey", "sauce", "stock", "broth", "chocolate", "almond", "walnut", "cashew",
    "peanut butter", "coconut milk", "tomato paste", "canned tomato", "syrup", "jam", "raisin", "breadcrumb"]],
  ["meat", ["chicken", "beef", "lamb", "goat", "mutton", "pork", "fish", "salmon", "shrimp", "prawn", "tuna",
    "mince", "turkey", "bacon", "sausage", "steak"]],
  ["dairy", ["milk", "butter", "cheese", "yogurt", "yoghurt", "cream", "egg", "paneer", "ghee", "buttermilk"]],
  ["bakery", ["bread", "bun", "tortilla", "pita", "naan", "bagel", "roll", "wrap"]],
  ["produce", ["onion", "garlic", "tomato", "potato", "carrot", "lettuce", "spinach", "pepper", "lemon", "lime",
    "apple", "banana", "berry", "berries", "cilantro", "coriander", "parsley", "basil", "mint", "ginger",
    "cucumber", "mushroom", "avocado", "zucchini", "broccoli", "cabbage", "celery", "scallion", "green onion",
    "chili", "chilli", "kale", "eggplant", "cauliflower", "okra", "mango", "orange", "herb", "dill", "leek"]],
];

const NUM = "(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.?\\d+\\s*[½⅓⅔¼¾⅛⅜⅝⅞]?|[½⅓⅔¼¾⅛⅜⅝⅞])";
const QTY_RE = new RegExp(`^(${NUM})(?:\\s*(?:-|–|to)\\s*${NUM})?\\s*(.*)$`);

function toNumber(text) {
  text = text.trim();
  let total = 0;
  for (const part of text.split(/\s+/)) {
    const frac = part.match(/^(\d*\.?\d*)([½⅓⅔¼¾⅛⅜⅝⅞])$/);
    if (frac) {
      total += (frac[1] ? parseFloat(frac[1]) : 0) + FRACTIONS[frac[2]];
    } else if (part.includes("/")) {
      const [a, b] = part.split("/").map(Number);
      if (b) total += a / b;
    } else {
      total += parseFloat(part) || 0;
    }
  }
  return total;
}

/** "2 1/2 cups flour, sifted" -> { qty: 2.5, unit: "cup", item: "flour, sifted" } */
export function parseIngredient(line) {
  let s = String(line).trim().replace(/^[-*•]\s*/, "");
  if (!s) return null;
  let qty = null;
  let unit = "";
  const q = s.match(QTY_RE);
  if (q && q[2]) {
    qty = toNumber(q[1]);
    s = q[2];
  }
  const u = s.match(/^([A-Za-z]+)\.?\s+(.+)$/);
  if (u) {
    const word = u[1];
    const found = UNITS[word] ?? UNITS[word.toLowerCase()];
    // Single letters only count as units straight after a number ("2 c sugar", "200 g rice").
    if (found && (word.length > 1 || qty != null)) {
      unit = found;
      s = u[2];
    }
  }
  s = s.replace(/^of\s+/i, "").trim();
  if (!s) return null;
  return { qty, unit, item: s };
}

/**
 * A line that starts a part of a recipe, like "## Marinade", "For the sauce:"
 * or "RAITA". Returns the part's name, or null for an ordinary line.
 */
export function sectionHeader(line) {
  const s = String(line).trim();
  if (!s) return null;
  let m = s.match(/^#+\s*(.+?)\s*:?$/);
  if (m) return cleanHeader(m[1]);
  m = s.match(/^(?:for\s+(?:the\s+)?)?([^\d½⅓⅔¼¾⅛⅜⅝⅞:][^:]{0,50}):$/i);
  if (m) return cleanHeader(m[1]);
  return null;
}

function cleanHeader(text) {
  let t = text.replace(/^for\s+(?:the\s+)?/i, "").replace(/\*+/g, "").trim();
  if (t === t.toUpperCase()) t = t.toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

/** One ingredient per line; header lines start a named part (ingredient.group). */
export function parseIngredients(text) {
  const out = [];
  let group = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = sectionHeader(line);
    if (header) {
      group = header;
      continue;
    }
    const ing = parseIngredient(line);
    if (ing) out.push(group ? { ...ing, group } : ing);
  }
  return out;
}

/** One step per line; header lines are kept as "## Part" entries. */
export function parseSteps(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = sectionHeader(line);
    if (header) out.push(`## ${header}`);
    else {
      const step = line.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, "").trim();
      if (step) out.push(step);
    }
  }
  return out;
}

/** Ingredients back to editable text, with "## Part" lines between parts. */
export function ingredientsToText(ingredients) {
  const lines = [];
  let group = "";
  for (const ing of ingredients || []) {
    if ((ing.group || "") !== group) {
      group = ing.group || "";
      if (lines.length) lines.push("");
      lines.push(group ? `## ${group}` : "## Other");
    }
    lines.push(formatIngredient(ing));
  }
  return lines.join("\n");
}

/** [{ group, items: [{ ing, index }] }] in recipe order. */
export function ingredientSections(ingredients) {
  const sections = [];
  (ingredients || []).forEach((ing, index) => {
    const group = ing.group || "";
    let sec = sections.find((s) => s.group === group);
    if (!sec) sections.push((sec = { group, items: [] }));
    sec.items.push({ ing, index });
  });
  return sections;
}

/** [{ group, steps: [text] }] from a steps array that may contain "## Part" entries. */
export function stepSections(steps) {
  const sections = [{ group: "", steps: [] }];
  for (const step of steps || []) {
    const m = String(step).match(/^##\s*(.+)$/);
    if (m) sections.push({ group: m[1].trim(), steps: [] });
    else sections[sections.length - 1].steps.push(step);
  }
  return sections.filter((s) => s.steps.length || s.group);
}

/* ------------------------------- Scaling -------------------------------- */

// Bigger units read better once an amount grows: 12 tsp -> 4 tbsp -> ¼ cup.
const UP = [
  ["tsp", 3, "tbsp"],
  ["tbsp", 4, "cup", 16],
  ["g", 1000, "kg"],
  ["ml", 1000, "l"],
  ["oz", 16, "lb"],
];

/** Scale an amount and tidy its unit. */
export function scaleAmount(qty, unit, factor) {
  if (qty == null) return { qty: null, unit: unit || "" };
  let q = qty * factor;
  let u = unit || "";
  for (const [from, at, to, per] of UP) {
    if (u === from && q >= at) {
      q = q / (per || at);
      u = to;
    }
  }
  // Kitchen amounts: 0.3125 tsp reads as ⅓ tsp, 1.6 cup as 1⅝ cup.
  if (factor !== 1 && q < 10 && !["g", "kg", "ml", "l"].includes(u)) q = nearestKitchen(q);
  return { qty: Math.round(q * 1000) / 1000, unit: u };
}

function nearestKitchen(q) {
  const whole = Math.floor(q);
  const steps = [0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1];
  const frac = steps.reduce((best, s) => (Math.abs(q - whole - s) < Math.abs(q - whole - best) ? s : best));
  return whole + frac || 1 / 8;
}

/** How much to multiply a recipe by for its chosen serving size. */
export function recipeFactor(recipe) {
  const f = Number(recipe?.scale);
  return f > 0 ? f : 1;
}

/** The name to shop for: drops prep notes after a comma and anything in brackets. */
const SIZE_WORDS = /^(?:(?:large|small|medium|big|fresh|ripe|whole|extra)\s+)+/i;

export function baseName(item) {
  const name = String(item).split(",")[0].replace(/\(.*?\)/g, "").replace(/\s+(?:to taste|as needed|for garnish)$/i, "").replace(/\s+/g, " ").trim();
  return name.replace(SIZE_WORDS, "") || name || String(item).trim();
}

function hash(text) {
  let h = 5381;
  for (const ch of text) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

/** Stable id for an ingredient, so "Eggs" in two recipes is one grocery line. */
export function keyOf(item) {
  const name = baseName(item).toLowerCase();
  let key = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Fold plurals and y/ies spellings together: chilies/chili, cherries/cherry, tomatoes/tomato.
  key = key.replace(/(oes|ies|y|s)$/, (m) => (m === "oes" ? "o" : m === "s" ? "" : "i"));
  if (!key || key.length < 2) key = "i-" + hash(name);
  return key.slice(0, 100);
}

export function aisleOf(item) {
  const name = " " + baseName(item).toLowerCase() + " ";
  for (const [aisle, words] of AISLE_WORDS) {
    for (const w of words) {
      if (new RegExp(`\\b${w}(?:s|es)?\\b`).test(name)) return aisle;
    }
  }
  return "other";
}

export function formatQty(q) {
  if (q == null || Number.isNaN(q)) return "";
  const whole = Math.floor(q);
  const frac = q - whole;
  for (const [sym, val] of Object.entries(FRACTIONS)) {
    if (Math.abs(frac - val) < 0.02) return (whole || "") + sym;
  }
  if (frac < 0.02) return String(whole);
  if (frac > 0.98) return String(whole + 1);
  return String(Math.round(q * 100) / 100);
}

export function formatIngredient(ing) {
  return [formatQty(ing.qty), ing.unit, ing.item].filter(Boolean).join(" ");
}

/** Adds up quantities that share a unit: [2 cup, 1 cup, 3 tbsp] -> "3 cup + 3 tbsp". */
export function combineAmounts(sources) {
  const byUnit = new Map();
  for (const s of sources) {
    if (s.qty == null) continue;
    const u = s.unit || "";
    byUnit.set(u, (byUnit.get(u) || 0) + s.qty);
  }
  return [...byUnit].map(([u, q]) => formatQty(q) + (u ? " " + u : "")).join(" + ");
}

export function titleCase(text) {
  const s = String(text).trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* -------------------------------- Speech -------------------------------- */

// Text for reading a recipe aloud: amounts and units as words, so any voice
// says "half a teaspoon of salt" rather than "one-half t-s-p salt".

const SPOKEN_UNITS = { tsp: "teaspoon", tbsp: "tablespoon", g: "gram", kg: "kilogram", ml: "millilitre", l: "litre", oz: "ounce", lb: "pound" };
const SPOKEN_FRACTIONS = [[1 / 2, "half", "a half"], [1 / 4, "a quarter", "a quarter"], [3 / 4, "three quarters", "three quarters"], [1 / 3, "a third", "a third"], [2 / 3, "two thirds", "two thirds"], [1 / 8, "an eighth", "an eighth"]];

function spokenQty(q) {
  const whole = Math.floor(q + 0.02);
  const frac = q - whole;
  if (frac < 0.02) return String(whole);
  const f = SPOKEN_FRACTIONS.find(([v]) => Math.abs(frac - v) < 0.02);
  if (!f) return String(Math.round(q * 100) / 100);
  return whole ? `${whole} and ${f[2]}` : f[1];
}

function plural(word) {
  return /(ch|sh|s|x)$/.test(word) ? word + "es" : word + "s";
}

/** "2 cups of basmati rice", "half a teaspoon of salt", "3 eggs". */
export function spokenIngredient(ing) {
  const item = speakable(ing.item);
  if (!ing.qty) return item;
  const amount = spokenQty(ing.qty);
  if (!ing.unit) return `${amount} ${item}`;
  if (ing.unit === "dozen") return `${amount} dozen ${item}`;
  const unit = SPOKEN_UNITS[ing.unit] || ing.unit;
  if (ing.qty < 1 && amount === "half") return `half a ${unit} of ${item}`;
  return `${amount} ${ing.qty > 1 ? plural(unit) : unit} of ${item}`;
}

/** Cooking shorthand in free text (steps, notes) said in words. */
export function speakable(text) {
  return String(text ?? "")
    .replace(/(\d)\s*°\s*C\b/g, "$1 degrees Celsius")
    .replace(/(\d)\s*°\s*F\b/g, "$1 degrees Fahrenheit")
    .replace(/(\d)\s*([½¼¾⅓⅔])/g, (_, d, f) => `${d} and ${SPOKEN_FRACTIONS.find(([v]) => Math.abs(FRACTIONS[f] - v) < 0.02)[2]}`)
    .replace(/[½¼¾⅓⅔]/g, (f) => SPOKEN_FRACTIONS.find(([v]) => Math.abs(FRACTIONS[f] - v) < 0.02)[1])
    .replace(/\b1\/2\b/g, "half")
    .replace(/\btbsps?\b/gi, "tablespoons")
    .replace(/\btsps?\b/gi, "teaspoons")
    .replace(/\bhalf (teaspoon|tablespoon|cup)s\b/g, "half a $1")
    .replace(/\bmins?\b/g, "minutes")
    .replace(/(\d)\s*(g|kg|ml)\b/g, (_, d, u) => `${d} ${plural(SPOKEN_UNITS[u])}`)
    .replace(/\s+/g, " ")
    .trim();
}

function spokenList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function spokenTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}

/**
 * A recipe as something to listen to. brief: the name, size, time and
 * ingredients, said after "ask AI" makes a recipe; otherwise everything,
 * for reading along while cooking.
 */
export function recipeSpeech(recipe, { brief = false } = {}) {
  const out = [brief ? `Here's ${speakable(recipe.name)}.` : `${speakable(recipe.name)}.`];
  const facts = [];
  if (recipe.servings) facts.push(`serves ${spokenQty(recipe.servings)}`);
  if (recipe.minutes) facts.push(`takes about ${spokenTime(recipe.minutes)}`);
  if (facts.length) out.push(`It ${facts.join(" and ")}.`);
  const sections = ingredientSections(recipe.ingredients);
  if (brief) {
    const all = sections.flatMap((s) => s.items.map((x) => spokenIngredient(x.ing)));
    if (all.length) out.push(`You'll need ${spokenList(all)}.`);
    out.push("Have a look, and save it if you like it.");
    return out.join(" ");
  }
  if (sections.length) out.push("Ingredients.");
  for (const sec of sections) {
    const list = spokenList(sec.items.map((x) => spokenIngredient(x.ing)));
    out.push(sec.group ? `For the ${speakable(sec.group)}: ${list}.` : `${titleCase(list)}.`);
  }
  const steps = stepSections(recipe.steps);
  if (steps.some((s) => s.steps.length)) out.push("Method.");
  let n = 0;
  for (const sec of steps) {
    if (sec.group) out.push(`For the ${speakable(sec.group)}.`);
    for (const step of sec.steps) out.push(`Step ${++n}. ${speakable(step).replace(/([^.!?])$/, "$1.")}`);
  }
  if (recipe.notes) out.push(`A note: ${speakable(recipe.notes)}`);
  return out.join(" ").replace(/\.\./g, ".");
}

/**
 * Splits text at sentence ends into pieces for a voice server: a short first
 * piece so the voice starts soon, then up to `max` characters each.
 */
export function speechChunks(text, { first = 180, max = 400 } = {}) {
  const pieces = String(text)
    .split(/(?<=[.!?:;])\s+|\n+/)
    .flatMap((s) => (s.length > max ? s.split(/(?<=,)\s+/) : [s]))
    .flatMap((s) => {
      const parts = [];
      while (s.length > max) {
        const cut = s.lastIndexOf(" ", max);
        parts.push(s.slice(0, cut > 0 ? cut : max));
        s = s.slice(cut > 0 ? cut + 1 : max);
      }
      return [...parts, s];
    })
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  for (const piece of pieces) {
    const limit = chunks.length > 1 ? max : first;
    if (chunks.length && chunks.at(-1).length + piece.length + 1 <= limit) chunks[chunks.length - 1] += " " + piece;
    else chunks.push(piece);
  }
  return chunks;
}
