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
