// Shapes of the documents the food board stores, cleaned on every save so a
// bad request cannot store junk. Nutrition is kept per serving so the calorie
// tracker can use it later.
import { fail, str } from './util.js';

const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Dessert', 'Snack', 'Drink', 'Other'];
const AISLES = ['produce', 'meat', 'dairy', 'bakery', 'pantry', 'spices', 'frozen', 'other'];

function num(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 1000) / 1000 : null;
}

function cleanUrl(value) {
  const s = str(value, 1000);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

export function cleanIngredient(ing) {
  const item = str(ing?.item, 200);
  if (!item) return null;
  return { qty: num(ing.qty, 100000), unit: str(ing.unit, 20), item };
}

export function cleanNutrition(n) {
  if (!n || typeof n !== 'object') return null;
  const out = {
    calories: num(n.calories, 20000),
    protein: num(n.protein, 2000),
    carbs: num(n.carbs, 2000),
    fat: num(n.fat, 2000),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

export function cleanRecipe(body) {
  const name = str(body.name, 150);
  if (!name) fail(400, 'Please give the recipe a name.');
  const ingredients = (Array.isArray(body.ingredients) ? body.ingredients : [])
    .slice(0, 100)
    .map(cleanIngredient)
    .filter(Boolean);
  const steps = (Array.isArray(body.steps) ? body.steps : [])
    .slice(0, 60)
    .map((s) => str(s, 2000))
    .filter(Boolean);
  const tags = (Array.isArray(body.tags) ? body.tags : []).slice(0, 12).map((t) => str(t, 30)).filter(Boolean);
  return {
    name,
    category: CATEGORIES.includes(body.category) ? body.category : 'Other',
    minutes: num(body.minutes, 10000),
    servings: num(body.servings, 1000),
    ingredients,
    steps,
    notes: str(body.notes, 4000),
    sourceUrl: cleanUrl(body.sourceUrl),
    image: cleanUrl(body.image),
    nutrition: cleanNutrition(body.nutrition),
    nutritionEstimated: body.nutritionEstimated === true,
    tags,
    example: body.example === true,
    createdAt: num(body.createdAt, 1e14) ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export function cleanGrocery(body) {
  const name = str(body.name, 200);
  if (!name) fail(400, 'Grocery items need a name.');
  const sources = (Array.isArray(body.sources) ? body.sources : []).slice(0, 50).map((s) => ({
    sid: str(s?.sid, 160),
    rid: str(s?.rid, 120),
    rname: str(s?.rname, 150),
    qty: num(s?.qty, 100000),
    unit: str(s?.unit, 20),
  }));
  return {
    name,
    aisle: AISLES.includes(body.aisle) ? body.aisle : 'other',
    bought: body.bought === true,
    sources,
    addedAt: num(body.addedAt, 1e14) ?? Date.now(),
  };
}

export { CATEGORIES };
