// Recipe Board: recipes -> ingredients -> grocery list.
import {
  AISLES,
  aisleOf,
  baseName,
  combineAmounts,
  formatIngredient,
  formatQty,
  keyOf,
  parseIngredient,
  parseIngredients,
  titleCase,
} from './lib.js';

const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Dessert', 'Snack', 'Drink', 'Other'];
const AISLE_NAME = Object.fromEntries(AISLES);

const S = { recipes: new Map(), grocery: new Map(), user: null };
const ui = {
  view: 'recipes',
  selected: null,
  editing: null, // null | { id, draft }
  confirmDelete: false,
  confirmClear: false,
  addMode: 'link',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* --------------------------------- API ---------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Please log in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

async function loadState() {
  const data = await api('/api/state');
  S.recipes = new Map(data.recipes.map((r) => [r.id, r]));
  S.grocery = new Map(data.grocery.map((g) => [g.id, g]));
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

// Optimistic writes: update the screen first, then save. On failure, reload.
async function save(coll, id, doc) {
  const map = coll === 'recipes' ? S.recipes : S.grocery;
  map.set(id, { ...doc, id });
  render();
  try {
    await api(`/api/${coll}/${encodeURIComponent(id)}`, { method: 'PUT', body: doc });
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
    await refresh();
  }
}

async function remove(coll, id) {
  const map = coll === 'recipes' ? S.recipes : S.grocery;
  map.delete(id);
  render();
  try {
    await api(`/api/${coll}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`);
    await refresh();
  }
}

async function refresh() {
  try {
    await loadState();
    render();
  } catch {
    // Offline or logged out; keep what's on screen.
  }
}

/* ------------------------------ Data helpers ----------------------------- */

const recipesSorted = () => [...S.recipes.values()].sort((a, b) => a.name.localeCompare(b.name));
const sid = (recipeId, index) => `${recipeId}#${index}`;

function isOnList(recipe, index) {
  const ing = recipe.ingredients[index];
  const g = S.grocery.get(keyOf(ing.item));
  return !!g?.sources?.some((s) => s.sid === sid(recipe.id, index));
}

/** Add or remove recipe ingredient uses (all sharing one grocery key) in a single write. */
async function setUses(key, uses, on) {
  const cur = S.grocery.get(key);
  const first = uses[0].ing;
  const doc = cur
    ? structuredClone({ ...cur, id: undefined })
    : { name: titleCase(baseName(first.item)), aisle: aisleOf(first.item), bought: false, sources: [], addedAt: Date.now() };
  delete doc.id;
  const ids = new Set(uses.map((u) => sid(u.recipe.id, u.index)));
  doc.sources = doc.sources.filter((s) => !ids.has(s.sid));
  if (on) {
    for (const u of uses) {
      doc.sources.push({ sid: sid(u.recipe.id, u.index), rid: u.recipe.id, rname: u.recipe.name, qty: u.ing.qty ?? null, unit: u.ing.unit || '' });
    }
    doc.bought = false;
  }
  if (doc.sources.length) await save('grocery', key, doc);
  else if (cur) await remove('grocery', key);
}

function usesByKey(recipe, indexes = recipe.ingredients.map((_, i) => i)) {
  const groups = new Map();
  for (const index of indexes) {
    const ing = recipe.ingredients[index];
    const key = keyOf(ing.item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ recipe, index, ing });
  }
  return groups;
}

async function addRecipeToList(recipe) {
  const missing = recipe.ingredients.map((_, i) => i).filter((i) => !isOnList(recipe, i));
  for (const [key, uses] of usesByKey(recipe, missing)) await setUses(key, uses, true);
  toast(missing.length ? `Added ${missing.length} item${missing.length === 1 ? '' : 's'} to the grocery list.` : 'Everything is already on the list.');
}

// When a recipe is edited or deleted, keep its grocery lines in step.
async function syncRecipeOnList(oldRecipe, newRecipe) {
  const touched = [...S.grocery.entries()].filter(([, g]) => g.sources?.some((s) => s.rid === oldRecipe.id));
  const keysOnList = new Set(touched.map(([k]) => k));
  for (const [key, g] of touched) {
    const doc = structuredClone(g);
    delete doc.id;
    doc.sources = doc.sources.filter((s) => s.rid !== oldRecipe.id);
    if (newRecipe) {
      newRecipe.ingredients.forEach((ing, i) => {
        if (keyOf(ing.item) === key) doc.sources.push({ sid: sid(newRecipe.id, i), rid: newRecipe.id, rname: newRecipe.name, qty: ing.qty ?? null, unit: ing.unit || '' });
      });
    }
    if (doc.sources.length) await save('grocery', key, doc);
    else await remove('grocery', key);
  }
  return keysOnList;
}

/* -------------------------------- Rendering ------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'for') node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
}

function render() {
  for (const v of ['recipes', 'ingredients', 'grocery']) {
    $(`#view-${v}`).hidden = ui.view !== v;
    $(`.flow-step[data-view="${v}"]`).setAttribute('aria-current', ui.view === v ? 'page' : 'false');
  }
  const ingredientKeys = new Set();
  for (const r of S.recipes.values()) for (const ing of r.ingredients) ingredientKeys.add(keyOf(ing.item));
  const toBuy = [...S.grocery.values()].filter((g) => !g.bought).length;
  $('#count-recipes').textContent = S.recipes.size;
  $('#count-ingredients').textContent = ingredientKeys.size;
  $('#count-grocery').textContent = toBuy;

  if (ui.view === 'recipes') renderRecipes();
  if (ui.view === 'ingredients') renderIngredients();
  if (ui.view === 'grocery') renderGrocery();
}

function metaLine(r) {
  const bits = [];
  if (r.minutes) bits.push(r.minutes >= 60 ? `${Math.floor(r.minutes / 60)} h ${r.minutes % 60 ? (r.minutes % 60) + ' min' : ''}`.trim() : `${r.minutes} min`);
  if (r.servings) bits.push(`serves ${formatQty(r.servings)}`);
  if (r.nutrition?.calories) bits.push(`${Math.round(r.nutrition.calories)} kcal`);
  return bits.join(' · ');
}

function renderRecipes() {
  const q = $('#recipe-search').value.trim().toLowerCase();
  const list = recipesSorted().filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.ingredients.some((i) => i.item.toLowerCase().includes(q)) || (r.tags || []).some((t) => t.includes(q)),
  );
  const cards = $('#recipe-cards');
  cards.replaceChildren();

  if (!S.recipes.size) {
    cards.append(
      el('div', { class: 'empty' },
        el('p', { class: 'empty-title', text: 'No recipes yet' }),
        el('p', { class: 'muted', text: 'Add one from a link, paste one in, or ask AI for an idea. Its ingredients show up on the Ingredients tab, ready for your grocery list.' }),
        el('button', { class: 'btn', type: 'button', 'data-act': 'load-examples', text: 'Add 3 example recipes' }),
      ),
    );
  } else if (!list.length) {
    cards.append(el('p', { class: 'muted pad', text: `No recipes match "${q}".` }));
  }

  for (const r of list) {
    const onList = r.ingredients.filter((_, i) => isOnList(r, i)).length;
    cards.append(
      el('button', { class: 'recipe-card', type: 'button', 'data-act': 'select', 'data-id': r.id, 'aria-pressed': String(ui.selected === r.id) },
        el('span', { class: 'rc-top' },
          el('span', { class: `chip cat cat-${r.category.toLowerCase()}`, text: r.category }),
          r.example ? el('span', { class: 'chip ghost', text: 'Example' }) : null,
        ),
        el('span', { class: 'rc-name', text: r.name }),
        el('span', { class: 'rc-meta', text: metaLine(r) || `${r.ingredients.length} ingredients` }),
        el('span', { class: 'rc-bar', 'aria-label': `${onList} of ${r.ingredients.length} ingredients on the grocery list` },
          el('span', { class: 'rc-bar-fill', style: `width:${r.ingredients.length ? (onList / r.ingredients.length) * 100 : 0}%` }),
        ),
        el('span', { class: 'rc-list', text: onList ? `${onList}/${r.ingredients.length} on grocery list` : `${r.ingredients.length} ingredients` }),
      ),
    );
  }

  if (ui.editing) {
    if (!$('#recipe-form')) renderEditor();
    return;
  }
  renderDetail();
}

function renderDetail() {
  const box = $('#detail');
  const r = S.recipes.get(ui.selected);
  box.replaceChildren();
  box.classList.toggle('is-open', !!r);
  document.body.classList.toggle('detail-open', !!r);
  if (!r) {
    box.append(
      el('div', { class: 'detail-empty' },
        el('p', { class: 'empty-title', text: S.recipes.size ? 'Pick a recipe' : 'Your recipes will appear here' }),
        el('p', { class: 'muted', text: 'Tick ingredients you need and they go straight onto the grocery list.' }),
      ),
    );
    return;
  }
  const onCount = r.ingredients.filter((_, i) => isOnList(r, i)).length;
  const n = r.nutrition;

  const parts = [
    el('button', { class: 'back-link', type: 'button', 'data-act': 'close-detail', text: '← All recipes' }),
    r.image ? el('img', { class: 'detail-img', src: r.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : null,
    el('div', { class: 'detail-head' },
      el('div', {},
        el('div', { class: 'rc-top' },
          el('span', { class: `chip cat cat-${r.category.toLowerCase()}`, text: r.category }),
          ...(r.tags || []).map((t) => el('span', { class: 'chip ghost', text: t })),
          r.example ? el('span', { class: 'chip ghost', text: 'Example' }) : null,
        ),
        el('h1', { text: r.name }),
        el('p', { class: 'muted', text: metaLine(r) }),
      ),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn', type: 'button', 'data-act': 'edit', text: 'Edit' }),
        ui.confirmDelete
          ? el('span', { class: 'confirm' },
              el('span', { text: 'Delete this recipe?' }),
              el('button', { class: 'btn btn-danger', type: 'button', 'data-act': 'delete-yes', text: 'Delete' }),
              el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'delete-no', text: 'Keep' }),
            )
          : el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'delete', text: 'Delete' }),
      ),
    ),
    n && (n.calories || n.protein)
      ? el('dl', { class: 'nutrition', 'aria-label': 'Nutrition per serving' },
          ...[['Calories', n.calories, 'kcal'], ['Protein', n.protein, 'g'], ['Carbs', n.carbs, 'g'], ['Fat', n.fat, 'g']]
            .filter(([, v]) => v != null)
            .map(([label, v, u]) => el('div', {}, el('dt', { text: label }), el('dd', {}, String(Math.round(v)), el('small', { text: ' ' + u })))),
          el('p', { class: 'hint', text: r.nutritionEstimated ? 'Per serving, estimated by AI.' : 'Per serving.' }),
        )
      : null,
    el('div', { class: 'detail-cols' },
      el('section', { class: 'ing-panel' },
        el('div', { class: 'panel-head' },
          el('h2', { text: 'Ingredients' }),
          el('button', { class: 'btn btn-small', type: 'button', 'data-act': 'add-all', disabled: onCount === r.ingredients.length || !r.ingredients.length, text: onCount === r.ingredients.length && r.ingredients.length ? 'All on list' : 'Add all to list' }),
        ),
        el('ul', { class: 'ing-list' },
          r.ingredients.map((ing, i) =>
            el('li', {},
              el('label', { class: 'check' },
                el('input', { type: 'checkbox', checked: isOnList(r, i), 'data-act': 'toggle-ing', 'data-index': i }),
                el('span', { class: 'qty', text: [formatQty(ing.qty), ing.unit].filter(Boolean).join(' ') }),
                el('span', { class: 'ing-name', text: ing.item }),
              ),
            ),
          ),
        ),
        el('p', { class: 'hint', text: 'Ticked items are on your grocery list.' }),
      ),
      el('section', { class: 'steps-panel' },
        el('h2', { text: 'Method' }),
        r.steps.length ? el('ol', { class: 'steps' }, r.steps.map((s) => el('li', { text: s }))) : el('p', { class: 'muted', text: 'No steps written yet.' }),
        r.notes ? el('div', { class: 'notes' }, el('h3', { text: 'Notes' }), el('p', { text: r.notes })) : null,
        r.sourceUrl ? el('p', { class: 'source' }, 'Source: ', el('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: new URL(r.sourceUrl).hostname.replace(/^www\./, '') })) : null,
      ),
    ),
  ];
  box.append(...parts.filter(Boolean));
}

/* --------------------------------- Editor -------------------------------- */

function renderEditor() {
  const box = $('#detail');
  const { draft, id } = ui.editing;
  box.classList.add('is-open');
  document.body.classList.add('detail-open');
  const n = draft.nutrition || {};
  const form = el('form', { id: 'recipe-form', class: 'editor', novalidate: true },
    el('div', { class: 'detail-head' },
      el('h1', { text: S.recipes.has(id) ? 'Edit recipe' : 'New recipe' }),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'cancel-edit', text: 'Cancel' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save recipe' }),
      ),
    ),
    draft.sourceUrl && !S.recipes.has(id) && /^https?:/.test(draft.sourceUrl) ? el('p', { class: 'hint', text: `Imported from ${new URL(draft.sourceUrl).hostname}. Check it over, then save.` }) : null,
    el('label', { class: 'field' }, el('span', { text: 'Name' }), el('input', { id: 'f-name', name: 'name', required: true, value: draft.name || '', maxLength: 150 })),
    el('div', { class: 'row3' },
      el('label', { class: 'field' }, el('span', { text: 'Meal' }),
        el('select', { id: 'f-category', name: 'category' }, CATEGORIES.map((c) => el('option', { value: c, selected: c === (draft.category || 'Dinner'), text: c })))),
      el('label', { class: 'field' }, el('span', { text: 'Total time (min)' }), el('input', { id: 'f-minutes', name: 'minutes', type: 'number', min: 0, inputMode: 'numeric', value: draft.minutes ?? '' })),
      el('label', { class: 'field' }, el('span', { text: 'Serves' }), el('input', { id: 'f-servings', name: 'servings', type: 'number', min: 0, inputMode: 'numeric', value: draft.servings ?? '' })),
    ),
    el('div', { class: 'editor-cols' },
      el('label', { class: 'field' },
        el('span', {}, 'Ingredients ', el('small', { text: 'one per line, amount first' })),
        el('textarea', { id: 'f-ingredients', name: 'ingredients', rows: 10, placeholder: '2 cups basmati rice\n1 lb chicken thighs\n3 cloves garlic, minced\nsalt to taste', value: (draft.ingredients || []).map(formatIngredient).join('\n') }),
      ),
      el('div', { class: 'field' },
        el('span', { text: 'How it reads' }),
        el('ul', { class: 'parse-preview', id: 'parse-preview' }),
      ),
    ),
    el('label', { class: 'field' },
      el('span', {}, 'Method ', el('small', { text: 'one step per line' })),
      el('textarea', { id: 'f-steps', name: 'steps', rows: 7, value: (draft.steps || []).join('\n') }),
    ),
    el('label', { class: 'field' }, el('span', { text: 'Notes' }), el('textarea', { id: 'f-notes', name: 'notes', rows: 2, value: draft.notes || '' })),
    el('fieldset', { class: 'nutri-edit' },
      el('legend', {}, 'Nutrition per serving ', el('small', { text: 'optional, used by the calorie tracker later' })),
      el('div', { class: 'row4' },
        ...[['calories', 'Calories (kcal)'], ['protein', 'Protein (g)'], ['carbs', 'Carbs (g)'], ['fat', 'Fat (g)']].map(([k, label]) =>
          el('label', { class: 'field' }, el('span', { text: label }), el('input', { id: `f-${k}`, name: k, type: 'number', min: 0, step: 'any', inputMode: 'decimal', value: n[k] ?? '' })),
        ),
      ),
    ),
    el('div', { class: 'row2' },
      el('label', { class: 'field' }, el('span', { text: 'Tags' }), el('input', { id: 'f-tags', name: 'tags', placeholder: 'pakistani, quick, vegetarian', value: (draft.tags || []).join(', ') })),
      el('label', { class: 'field' }, el('span', { text: 'Source link' }), el('input', { id: 'f-source', name: 'sourceUrl', type: 'url', value: draft.sourceUrl || '' })),
    ),
    el('p', { class: 'msg err', id: 'form-error', hidden: true }),
  );
  box.replaceChildren(form);
  updatePreview();
  $('#f-ingredients').addEventListener('input', updatePreview);
  form.addEventListener('submit', submitRecipe);
  $('#f-name').focus({ preventScroll: true });
  box.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function updatePreview() {
  const list = parseIngredients($('#f-ingredients').value);
  $('#parse-preview').replaceChildren(
    ...(list.length
      ? list.map((ing) =>
          el('li', {},
            el('span', { class: 'qty', text: [formatQty(ing.qty), ing.unit].filter(Boolean).join(' ') || '·' }),
            el('span', { text: baseName(ing.item) }),
            el('span', { class: 'aisle-tag', text: AISLE_NAME[aisleOf(ing.item)] }),
          ),
        )
      : [el('li', { class: 'muted', text: 'Type ingredients to see how they’ll be grouped for shopping.' })]),
  );
}

async function submitRecipe(e) {
  e.preventDefault();
  const f = e.target.elements;
  const err = $('#form-error');
  const name = f.name.value.trim();
  if (!name) {
    err.textContent = 'Give the recipe a name.';
    err.hidden = false;
    f.name.focus();
    return;
  }
  const { id, draft } = ui.editing;
  const old = S.recipes.get(id);
  const number = (v) => (v === '' ? null : Number(v));
  const recipe = {
    name,
    category: f.category.value,
    minutes: number(f.minutes.value),
    servings: number(f.servings.value),
    ingredients: parseIngredients(f.ingredients.value),
    steps: f.steps.value.split(/\r?\n/).map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean),
    notes: f.notes.value.trim(),
    nutrition: { calories: number(f.calories.value), protein: number(f.protein.value), carbs: number(f.carbs.value), fat: number(f.fat.value) },
    nutritionEstimated: !!draft.nutritionEstimated && (draft.nutrition?.calories ?? null) === number(f.calories.value),
    tags: f.tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    sourceUrl: f.sourceUrl.value.trim(),
    image: draft.image || '',
    example: !!old?.example,
    createdAt: old?.createdAt || Date.now(),
  };
  ui.editing = null;
  ui.selected = id;
  await save('recipes', id, recipe);
  if (old) await syncRecipeOnList(old, { ...recipe, id });
  toast(old ? 'Recipe saved.' : 'Recipe added. Tick ingredients to put them on your grocery list.');
}

function startEditing(id, draft) {
  ui.editing = { id, draft: structuredClone(draft) };
  ui.confirmDelete = false;
  $('#detail').replaceChildren();
  setView('recipes');
}

/* ------------------------------- Ingredients ------------------------------ */

function renderIngredients() {
  const q = $('#ingredient-search').value.trim().toLowerCase();
  const sel = $('#ingredient-recipe');
  const chosen = sel.value;
  sel.replaceChildren(el('option', { value: '', text: 'All recipes' }), ...recipesSorted().map((r) => el('option', { value: r.id, selected: r.id === chosen, text: r.name })));
  if (chosen && !S.recipes.has(chosen)) sel.value = '';

  const byKey = new Map();
  for (const r of recipesSorted()) {
    if (sel.value && r.id !== sel.value) continue;
    r.ingredients.forEach((ing, index) => {
      const key = keyOf(ing.item);
      if (!byKey.has(key)) byKey.set(key, { key, name: titleCase(baseName(ing.item)), aisle: aisleOf(ing.item), uses: [] });
      byKey.get(key).uses.push({ recipe: r, index, ing });
    });
  }
  const rows = [...byKey.values()].filter((row) => !q || row.name.toLowerCase().includes(q));
  const box = $('#ingredient-groups');
  box.replaceChildren();
  if (!rows.length) {
    box.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: S.recipes.size ? 'No ingredients match' : 'No ingredients yet' }),
      el('p', { class: 'muted', text: S.recipes.size ? 'Try a different search.' : 'Add a recipe and its ingredients will be listed here, grouped by aisle.' }),
    ));
    return;
  }
  for (const [aisle, label] of AISLES) {
    const inAisle = rows.filter((r) => r.aisle === aisle).sort((a, b) => a.name.localeCompare(b.name));
    if (!inAisle.length) continue;
    box.append(
      el('section', { class: 'aisle' },
        el('h2', { class: 'aisle-name' }, label, el('span', { class: 'aisle-count', text: inAisle.length })),
        el('ul', { class: 'ing-rows' },
          inAisle.map((row) => {
            const on = row.uses.filter((u) => isOnList(u.recipe, u.index)).length;
            const all = on === row.uses.length;
            return el('li', { class: `ing-row${on ? ' on' : ''}` },
              el('label', { class: 'check' },
                el('input', { type: 'checkbox', checked: all, indeterminate: on > 0 && !all, 'data-act': 'toggle-key', 'data-key': row.key, 'aria-label': `${row.name}: ${all ? 'remove from' : 'add to'} grocery list` }),
                el('span', { class: 'ing-name', text: row.name }),
              ),
              el('div', { class: 'uses' },
                row.uses.map((u) =>
                  el('button', {
                    class: 'use-chip', type: 'button', 'data-act': 'toggle-use', 'data-rid': u.recipe.id, 'data-index': u.index,
                    'aria-pressed': String(isOnList(u.recipe, u.index)),
                    title: isOnList(u.recipe, u.index) ? 'On the grocery list. Tap to remove.' : 'Tap to add to the grocery list.',
                  },
                  el('span', { text: u.recipe.name }),
                  el('span', { class: 'qty', text: [formatQty(u.ing.qty), u.ing.unit].filter(Boolean).join(' ') || 'some' })),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}

/* ------------------------------- Grocery list ----------------------------- */

function groceryAmount(g) {
  const amount = combineAmounts(g.sources || []);
  const recipes = [...new Set((g.sources || []).map((s) => s.rname).filter(Boolean))];
  return { amount, recipes };
}

function renderGrocery() {
  const items = [...S.grocery.values()];
  const left = items.filter((g) => !g.bought).length;
  $('#grocery-summary').textContent = items.length
    ? `${left} to buy${items.length - left ? `, ${items.length - left} ticked off` : ''}.`
    : 'Nothing to buy yet. Tick ingredients in a recipe, or add items here.';
  $('#grocery-actions').hidden = !items.length;
  $('#clear-bought').disabled = !items.some((g) => g.bought);
  const wrap = $('#clear-all-wrap');
  wrap.replaceChildren(
    ui.confirmClear
      ? el('span', { class: 'confirm' },
          el('span', { text: 'Clear the whole list?' }),
          el('button', { class: 'btn btn-danger', type: 'button', 'data-act': 'clear-yes', text: 'Clear' }),
          el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'clear-no', text: 'Keep' }))
      : el('button', { class: 'btn btn-danger-ghost', type: 'button', 'data-act': 'clear-all', text: 'Clear list' }),
  );

  const box = $('#grocery-groups');
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: 'Your list is empty' }),
      el('p', { class: 'muted', text: 'Open a recipe and tick what you need, or use the Ingredients tab to shop for several recipes at once.' }),
    ));
    return;
  }
  for (const [aisle, label] of AISLES) {
    const inAisle = items.filter((g) => g.aisle === aisle).sort((a, b) => a.bought - b.bought || a.name.localeCompare(b.name));
    if (!inAisle.length) continue;
    box.append(
      el('section', { class: 'aisle' },
        el('h2', { class: 'aisle-name' }, label, el('span', { class: 'aisle-count', text: inAisle.filter((g) => !g.bought).length })),
        el('ul', { class: 'grocery-rows' },
          inAisle.map((g) => {
            const { amount, recipes } = groceryAmount(g);
            return el('li', { class: `g-row${g.bought ? ' bought' : ''}` },
              el('label', { class: 'check' },
                el('input', { type: 'checkbox', checked: !!g.bought, 'data-act': 'toggle-bought', 'data-key': g.id }),
                el('span', { class: 'g-text' },
                  el('span', { class: 'g-name' }, g.name, amount ? el('span', { class: 'qty', text: amount }) : null),
                  recipes.length ? el('span', { class: 'g-for', text: `for ${recipes.join(', ')}` }) : null,
                ),
              ),
              el('button', { class: 'icon-btn', type: 'button', 'data-act': 'remove-item', 'data-key': g.id, 'aria-label': `Remove ${g.name}`, text: '×' }),
            );
          }),
        ),
      ),
    );
  }
}

function groceryText() {
  const lines = [];
  for (const [aisle, label] of AISLES) {
    const inAisle = [...S.grocery.values()].filter((g) => g.aisle === aisle && !g.bought);
    if (!inAisle.length) continue;
    lines.push(label.toUpperCase());
    for (const g of inAisle) {
      const { amount } = groceryAmount(g);
      lines.push(`- ${g.name}${amount ? ` (${amount})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function addManualItem(text) {
  const ing = parseIngredient(text);
  if (!ing) return;
  const key = keyOf(ing.item);
  const cur = S.grocery.get(key);
  const doc = cur ? structuredClone(cur) : { name: titleCase(baseName(ing.item)), aisle: aisleOf(ing.item), bought: false, sources: [], addedAt: Date.now() };
  delete doc.id;
  doc.sources.push({ sid: `manual-${newId()}`, rid: '', rname: '', qty: ing.qty ?? null, unit: ing.unit || '' });
  doc.bought = false;
  await save('grocery', key, doc);
}

/* ------------------------------- Add recipe ------------------------------- */

function setAddMode(mode) {
  ui.addMode = mode;
  $$('.add-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $$('.add-pane').forEach((p) => (p.hidden = p.dataset.pane !== mode));
  $('#add-go').textContent = { link: 'Get recipe', paste: 'Read recipe', generate: 'Create recipe', manual: 'Start writing' }[mode];
  $('#add-note').textContent = mode === 'manual' ? '' : "You can check and edit everything before it's saved.";
  $('#add-error').hidden = true;
}

async function runAdd() {
  const mode = ui.addMode;
  const errBox = $('#add-error');
  errBox.hidden = true;
  if (mode === 'manual') {
    $('#add-dialog').close();
    startEditing(newId(), { name: '', category: 'Dinner', ingredients: [], steps: [] });
    return;
  }
  const go = $('#add-go');
  const label = go.textContent;
  go.disabled = true;
  go.textContent = mode === 'link' ? 'Reading the page…' : mode === 'paste' ? 'Reading…' : 'Writing a recipe…';
  try {
    const req = {
      link: ['/api/ai/import', { url: $('#ai-url').value.trim() }],
      paste: ['/api/ai/parse', { text: $('#ai-text').value }],
      generate: ['/api/ai/generate', { prompt: $('#ai-prompt').value }],
    }[mode];
    const { recipe } = await api(req[0], { method: 'POST', body: req[1] });
    $('#add-dialog').close();
    $('#ai-url').value = $('#ai-text').value = $('#ai-prompt').value = '';
    startEditing(newId(), recipe);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    go.disabled = false;
    go.textContent = label;
  }
}

/* --------------------------------- Account -------------------------------- */

async function openSettings() {
  $('#signed-in-as').textContent = S.user ? `Signed in as ${S.user.name} (${S.user.email}).` : '';
  $('#settings-dialog').showModal();
  try {
    const { users } = await api('/api/users');
    $('#people').replaceChildren(
      ...users.map((u) =>
        el('li', {},
          el('span', {}, el('strong', { text: u.name }), ' ', el('span', { class: 'muted', text: u.email })),
          u.id === S.user?.id ? el('span', { class: 'chip ghost', text: 'You' }) : el('button', { class: 'btn btn-small btn-danger-ghost', type: 'button', 'data-act': 'remove-person', 'data-id': u.id, text: 'Remove' }),
        ),
      ),
    );
  } catch (err) {
    toast(err.message);
  }
}

function formMsg(form, text, ok) {
  const m = $('.msg', form);
  m.textContent = text;
  m.className = `msg ${ok ? 'ok' : 'err'}`;
  m.hidden = false;
}

/* ---------------------------------- Misc ---------------------------------- */

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function setView(view) {
  ui.view = view;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
  if (view !== 'recipes') window.scrollTo({ top: 0 });
}

const EXAMPLES = [
  {
    name: 'Chicken karahi', category: 'Dinner', minutes: 45, servings: 4, tags: ['pakistani'],
    ingredients: parseIngredients('2 lb chicken, bone-in pieces\n4 tomatoes, chopped\n1 tbsp ginger garlic paste\n4 green chilies, slit\n1/2 cup oil\n1 tsp salt\n1 tsp red chili powder\n1 tsp cumin seeds\n1/2 cup yogurt\n1 bunch cilantro, chopped\n1 inch ginger, julienned'),
    steps: ['Heat oil in a karahi and fry the chicken on high heat until it changes colour.', 'Add ginger garlic paste, salt and chili powder and stir for a minute.', 'Add tomatoes, cover and cook until they break down, about 10 minutes.', 'Mash the tomatoes, add yogurt and cook on high until the oil separates.', 'Finish with green chilies, cumin, ginger and cilantro.'],
    notes: 'Example recipe. Edit it or delete it any time.',
    nutrition: { calories: 520, protein: 42, carbs: 9, fat: 35 }, nutritionEstimated: true,
  },
  {
    name: 'Masala omelette', category: 'Breakfast', minutes: 10, servings: 1, tags: ['quick'],
    ingredients: parseIngredients('3 eggs\n1 small onion, finely chopped\n1 tomato, diced\n1 green chili, chopped\n2 tbsp cilantro\n1/4 tsp salt\n1 tbsp butter'),
    steps: ['Beat the eggs with salt.', 'Stir in onion, tomato, chili and cilantro.', 'Melt butter in a pan, pour in the eggs and cook until set, then fold.'],
    notes: 'Example recipe.',
    nutrition: { calories: 330, protein: 20, carbs: 9, fat: 24 }, nutritionEstimated: true,
  },
  {
    name: 'Banana oat pancakes', category: 'Breakfast', minutes: 20, servings: 2, tags: ['vegetarian'],
    ingredients: parseIngredients('2 bananas\n2 eggs\n1 cup oats\n1/2 cup milk\n1 tsp baking powder\n1 pinch salt\n1 tbsp butter\n2 tbsp honey'),
    steps: ['Blend bananas, eggs, oats, milk, baking powder and salt until smooth.', 'Rest the batter for 5 minutes.', 'Cook small pancakes in butter over medium heat, 2 minutes a side.', 'Serve with honey.'],
    notes: 'Example recipe.',
    nutrition: { calories: 450, protein: 16, carbs: 68, fat: 14 }, nutritionEstimated: true,
  },
];

async function loadExamples() {
  for (const ex of EXAMPLES) await save('recipes', newId(), { ...ex, example: true, createdAt: Date.now() });
  ui.selected = recipesSorted()[0]?.id || null;
  render();
}

/* --------------------------------- Events --------------------------------- */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const r = S.recipes.get(ui.selected);

  if (act === 'select') {
    ui.selected = t.dataset.id;
    ui.editing = null;
    ui.confirmDelete = false;
    render();
    if (matchMedia('(max-width: 800px)').matches) window.scrollTo({ top: 0 });
  } else if (act === 'close-detail') {
    ui.selected = null;
    render();
  } else if (act === 'edit' && r) {
    startEditing(r.id, r);
  } else if (act === 'cancel-edit') {
    ui.editing = null;
    renderRecipes();
  } else if (act === 'delete') {
    ui.confirmDelete = true;
    renderDetail();
  } else if (act === 'delete-no') {
    ui.confirmDelete = false;
    renderDetail();
  } else if (act === 'delete-yes' && r) {
    ui.confirmDelete = false;
    ui.selected = null;
    await remove('recipes', r.id);
    await syncRecipeOnList(r, null);
    toast(`Deleted ${r.name}.`);
  } else if (act === 'toggle-ing' && r) {
    const index = Number(t.dataset.index);
    const ing = r.ingredients[index];
    await setUses(keyOf(ing.item), [{ recipe: r, index, ing }], t.checked);
  } else if (act === 'add-all' && r) {
    await addRecipeToList(r);
  } else if (act === 'toggle-use') {
    const recipe = S.recipes.get(t.dataset.rid);
    const index = Number(t.dataset.index);
    const ing = recipe.ingredients[index];
    await setUses(keyOf(ing.item), [{ recipe, index, ing }], !isOnList(recipe, index));
  } else if (act === 'toggle-key') {
    const key = t.dataset.key;
    const filter = $('#ingredient-recipe').value;
    const uses = [];
    for (const recipe of S.recipes.values()) {
      if (filter && recipe.id !== filter) continue;
      recipe.ingredients.forEach((ing, index) => keyOf(ing.item) === key && uses.push({ recipe, index, ing }));
    }
    if (uses.length) await setUses(key, uses, t.checked);
  } else if (act === 'toggle-bought') {
    const g = S.grocery.get(t.dataset.key);
    if (g) {
      const doc = { ...g, bought: t.checked };
      delete doc.id;
      await save('grocery', g.id, doc);
    }
  } else if (act === 'remove-item') {
    await remove('grocery', t.dataset.key);
  } else if (act === 'clear-all') {
    ui.confirmClear = true;
    renderGrocery();
  } else if (act === 'clear-no') {
    ui.confirmClear = false;
    renderGrocery();
  } else if (act === 'clear-yes') {
    ui.confirmClear = false;
    S.grocery.clear();
    render();
    await api('/api/grocery', { method: 'DELETE' }).catch((err) => toast(err.message));
    await refresh();
  } else if (act === 'load-examples') {
    t.disabled = true;
    await loadExamples();
  } else if (act === 'remove-person') {
    try {
      await api(`/api/users/${t.dataset.id}`, { method: 'DELETE' });
      openSettings();
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#new-recipe').addEventListener('click', () => {
  setAddMode(ui.addMode);
  $('#add-dialog').showModal();
});
$$('.add-tab').forEach((tab) => tab.addEventListener('click', () => setAddMode(tab.dataset.mode)));
$('#add-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  runAdd();
});

$('#recipe-search').addEventListener('input', renderRecipes);
$('#ingredient-search').addEventListener('input', renderIngredients);
$('#ingredient-recipe').addEventListener('change', renderIngredients);

$('#add-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#new-item');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await addManualItem(text);
});

$('#copy-list').addEventListener('click', async () => {
  const text = groceryText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Grocery list copied. Paste it into a message or notes.');
  } catch {
    toast('Copying is blocked here. Select the list and copy it instead.');
  }
});
$('#clear-bought').addEventListener('click', async () => {
  for (const [k, g] of S.grocery) if (g.bought) S.grocery.delete(k);
  render();
  await api('/api/grocery?only=bought', { method: 'DELETE' }).catch((err) => toast(err.message));
  await refresh();
});

$('#open-settings').addEventListener('click', openSettings);
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});
$('#add-person').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    formMsg(form, 'Added. Share the email and password with them.', true);
    form.reset();
    openSettings();
  } catch (err) {
    formMsg(form, err.message, false);
  }
});
$('#change-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/api/account/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    formMsg(form, 'Password changed. Other devices have been logged out.', true);
    form.reset();
  } catch (err) {
    formMsg(form, err.message, false);
  }
});

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (['recipes', 'ingredients', 'grocery'].includes(v) && v !== ui.view) setView(v);
});
$$('.flow-step').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setView(a.dataset.view);
  }),
);

// Pick up changes made on another device (e.g. ticking items off at the store).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !ui.editing) refresh();
});

/* ---------------------------------- Start --------------------------------- */

(async () => {
  try {
    const { user } = await api('/api/session');
    if (!user) {
      location.href = '/login';
      return;
    }
    S.user = user;
    $('#open-settings').hidden = false;
    await loadState();
  } catch (err) {
    $('#loading').textContent = `Couldn't load your board: ${err.message}`;
    return;
  }
  $('#loading').hidden = true;
  const v = location.hash.slice(1);
  ui.view = ['recipes', 'ingredients', 'grocery'].includes(v) ? v : 'recipes';
  if (!matchMedia('(max-width: 800px)').matches) ui.selected = recipesSorted()[0]?.id || null;
  render();
})();
