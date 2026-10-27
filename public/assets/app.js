// Recipe Board: recipes -> ingredients -> grocery list.
import {
  AISLES,
  aisleOf,
  baseName,
  combineAmounts,
  formatQty,
  ingredientSections,
  ingredientsToText,
  keyOf,
  parseIngredient,
  parseIngredients,
  parseSteps,
  recipeFactor,
  recipeSpeech,
  scaleAmount,
  stepSections,
  titleCase,
} from './lib.js';
import { canListen, listen, retryServerVoice, speak, stopSpeaking, unlockAudio } from './talk.js';

const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Dessert', 'Snack', 'Drink', 'Other'];
const AISLE_NAME = Object.fromEntries(AISLES);
const MAX_PHOTOS = 3;

const S = { recipes: new Map(), grocery: new Map(), user: null };
const ui = {
  view: 'recipes',
  selected: null,
  editing: null, // null | { id, draft }
  confirmDelete: false,
  confirmSplit: false,
  confirmClear: false,
  addMode: matchMedia('(pointer: coarse)').matches ? 'photo' : 'link',
  filter: readPref('rb-filter', ''),
  photos: [], // data URLs waiting to be read
  listening: null, // function that stops listening, while the mic is on
  talkReply: false, // read the next "ask AI" recipe aloud
  reading: null, // id of the recipe being read aloud, or 'ai'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked; the choice just won't be remembered.
  }
}

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
  if (!res.ok || data.error) throw new Error(data.error || friendlyStatus(res.status));
  return data;
}

// Cloudflare's own error pages aren't JSON, so there is no reason to show.
function friendlyStatus(status) {
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(status)) {
    return `The recipe server didn't answer (${status}). It may be restarting; try again in a minute.`;
  }
  return `Request failed (${status}).`;
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

function stripId(doc) {
  const copy = structuredClone(doc);
  delete copy.id;
  return copy;
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
const components = (r) => (r.components || []).map((id) => S.recipes.get(id)).filter(Boolean);
const usedIn = (r) => recipesSorted().filter((p) => (p.components || []).includes(r.id));

/** An ingredient's amount at the recipe's chosen serving size. */
function scaled(recipe, ing) {
  return scaleAmount(ing.qty, ing.unit, recipeFactor(recipe));
}
const amountText = (a) => [formatQty(a.qty), a.unit].filter(Boolean).join(' ');

function isOnList(recipe, index) {
  const ing = recipe.ingredients[index];
  const g = S.grocery.get(keyOf(ing.item));
  return !!g?.sources?.some((s) => s.sid === sid(recipe.id, index));
}

function sourceFor(recipe, index) {
  const a = scaled(recipe, recipe.ingredients[index]);
  return { sid: sid(recipe.id, index), rid: recipe.id, rname: recipe.name, qty: a.qty, unit: a.unit };
}

/** Add or remove recipe ingredient uses (all sharing one grocery key) in a single write. */
async function setUses(key, uses, on) {
  const cur = S.grocery.get(key);
  const first = uses[0].ing;
  const doc = cur
    ? stripId(cur)
    : { name: titleCase(baseName(first.item)), aisle: aisleOf(first.item), bought: false, sources: [], addedAt: Date.now() };
  const ids = new Set(uses.map((u) => sid(u.recipe.id, u.index)));
  doc.sources = doc.sources.filter((s) => !ids.has(s.sid));
  if (on) {
    for (const u of uses) doc.sources.push(sourceFor(u.recipe, u.index));
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

async function addToList(recipe, indexes) {
  const missing = indexes.filter((i) => !isOnList(recipe, i));
  for (const [key, uses] of usesByKey(recipe, missing)) await setUses(key, uses, true);
  return missing.length;
}

async function addRecipeToList(recipe, { withParts = true } = {}) {
  let added = await addToList(recipe, recipe.ingredients.map((_, i) => i));
  if (withParts) {
    for (const part of components(recipe)) added += await addToList(part, part.ingredients.map((_, i) => i));
  }
  toast(added ? `Added ${added} item${added === 1 ? '' : 's'} to the grocery list.` : 'Everything is already on the list.');
}

// When a recipe is edited, rescaled or deleted, keep its grocery lines in step.
async function syncRecipeOnList(oldRecipe, newRecipe) {
  const touched = [...S.grocery.entries()].filter(([, g]) => g.sources?.some((s) => s.rid === oldRecipe.id));
  for (const [key, g] of touched) {
    const doc = stripId(g);
    doc.sources = doc.sources.filter((s) => s.rid !== oldRecipe.id);
    if (newRecipe) {
      newRecipe.ingredients.forEach((ing, i) => {
        if (keyOf(ing.item) === key) doc.sources.push(sourceFor(newRecipe, i));
      });
    }
    if (doc.sources.length) await save('grocery', key, doc);
    else await remove('grocery', key);
  }
}

/* ------------------------------ Serving size ----------------------------- */

const SCALE_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10];
let scaleTimer;
const scalePending = new Set();

function servingsLabel(r) {
  const f = recipeFactor(r);
  if (r.servings) return `${formatQty(Math.round(r.servings * f * 100) / 100)}`;
  return `×${formatQty(f)}`;
}

function nextScale(r, dir) {
  const f = recipeFactor(r);
  if (r.servings) {
    const target = Math.max(1, Math.round(r.servings * f) + dir);
    return target / r.servings;
  }
  const i = SCALE_STEPS.findIndex((s) => s >= f - 1e-9);
  const at = i < 0 ? SCALE_STEPS.length - 1 : i;
  return SCALE_STEPS[Math.min(SCALE_STEPS.length - 1, Math.max(0, at + dir))];
}

function setScale(r, scale) {
  const old = S.recipes.get(r.id);
  const ratio = scale / recipeFactor(old);
  S.recipes.set(r.id, { ...old, scale });
  scalePending.add(r.id);
  // Linked parts (a dough, a sauce) grow with the dish they're made for.
  for (const p of components(old)) {
    S.recipes.set(p.id, { ...p, scale: Math.round(recipeFactor(p) * ratio * 1000) / 1000 });
    scalePending.add(p.id);
  }
  renderDetail();
  // Save once the person stops tapping, then update amounts already on the list.
  clearTimeout(scaleTimer);
  scaleTimer = setTimeout(async () => {
    const ids = [...scalePending];
    scalePending.clear();
    for (const id of ids) {
      const current = S.recipes.get(id);
      if (!current) continue;
      await save('recipes', id, stripId(current));
      await syncRecipeOnList(current, current);
    }
    renderRecipes();
  }, 600);
}

/** A split-off part is named "Marinade (Chicken tikka)"; inside its parent, "Marinade" is enough. */
function partName(part, parent) {
  const suffix = ` (${parent.name})`;
  return part.name.endsWith(suffix) ? part.name.slice(0, -suffix.length) : part.name;
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

function metaLine(r, { scaled: useScale = false } = {}) {
  const bits = [];
  if (r.minutes) bits.push(r.minutes >= 60 ? `${Math.floor(r.minutes / 60)} h ${r.minutes % 60 ? (r.minutes % 60) + ' min' : ''}`.trim() : `${r.minutes} min`);
  if (r.servings) bits.push(`serves ${useScale ? servingsLabel(r) : formatQty(r.servings)}`);
  if (r.nutrition?.calories) bits.push(`${Math.round(r.nutrition.calories)} kcal`);
  return bits.join(' · ');
}

function renderFilters() {
  const box = $('#recipe-filters');
  const counts = new Map();
  for (const r of S.recipes.values()) counts.set(r.category, (counts.get(r.category) || 0) + 1);
  if (ui.filter && !counts.has(ui.filter)) ui.filter = '';
  box.hidden = counts.size < 2;
  box.replaceChildren(
    el('button', { class: 'filter-chip', type: 'button', 'data-act': 'filter', 'data-cat': '', 'aria-pressed': String(!ui.filter) }, 'All ', el('span', { class: 'count', text: S.recipes.size })),
    ...CATEGORIES.filter((c) => counts.has(c)).map((c) =>
      el('button', { class: 'filter-chip', type: 'button', 'data-act': 'filter', 'data-cat': c, 'aria-pressed': String(ui.filter === c) }, c + ' ', el('span', { class: 'count', text: counts.get(c) })),
    ),
  );
}

function renderRecipes() {
  renderFilters();
  const q = $('#recipe-search').value.trim().toLowerCase();
  const list = recipesSorted().filter(
    (r) =>
      (!ui.filter || r.category === ui.filter) &&
      (!q || r.name.toLowerCase().includes(q) || r.ingredients.some((i) => i.item.toLowerCase().includes(q)) || (r.tags || []).some((t) => t.includes(q))),
  );
  const cards = $('#recipe-cards');
  cards.replaceChildren();

  if (!S.recipes.size) {
    cards.append(
      el('div', { class: 'empty' },
        el('p', { class: 'empty-title', text: 'No recipes yet' }),
        el('p', { class: 'muted', text: 'Snap a photo of a recipe, add one from a link, or ask AI for an idea. Its ingredients show up on the Ingredients tab, ready for your grocery list.' }),
        el('button', { class: 'btn', type: 'button', 'data-act': 'load-examples', text: 'Add 3 example recipes' }),
      ),
    );
  } else if (!list.length) {
    cards.append(el('p', { class: 'muted pad', text: q ? `No ${ui.filter ? ui.filter.toLowerCase() + ' ' : ''}recipes match "${q}".` : `No ${ui.filter.toLowerCase()} recipes yet.` }));
  }

  for (const r of list) {
    const parts = components(r);
    // A dish made from linked parts counts their ingredients too.
    const all = [r, ...parts].flatMap((x) => x.ingredients.map((_, i) => [x, i]));
    const onList = all.filter(([x, i]) => isOnList(x, i)).length;
    const total = all.length;
    const parents = usedIn(r);
    cards.append(
      el('button', { class: 'recipe-card', type: 'button', 'data-act': 'select', 'data-id': r.id, 'aria-pressed': String(ui.selected === r.id) },
        el('span', { class: 'rc-top' },
          el('span', { class: `chip cat cat-${r.category.toLowerCase()}`, text: r.category }),
          r.example ? el('span', { class: 'chip ghost', text: 'Example' }) : null,
        ),
        el('span', { class: 'rc-name', text: r.name }),
        el('span', { class: 'rc-meta', text: metaLine(r) || `${r.ingredients.length} ingredients` }),
        parts.length ? el('span', { class: 'rc-link', text: `Made with ${parts.map((p) => partName(p, r).toLowerCase()).join(', ')}` }) : null,
        parents.length ? el('span', { class: 'rc-link', text: `Part of ${parents.map((p) => p.name).join(', ')}` }) : null,
        el('span', { class: 'rc-bar', 'aria-label': `${onList} of ${total} ingredients on the grocery list` },
          el('span', { class: 'rc-bar-fill', style: `width:${total ? (onList / total) * 100 : 0}%` }),
        ),
        el('span', { class: 'rc-list', text: onList ? `${onList}/${total} on grocery list` : `${total} ingredients` }),
      ),
    );
  }

  if (ui.editing) {
    if (!$('#recipe-form')) renderEditor();
    return;
  }
  renderDetail();
}

function ingredientRows(recipe, items) {
  return el('ul', { class: 'ing-list' },
    items.map(({ ing, index }) =>
      el('li', {},
        el('label', { class: 'check' },
          el('input', { type: 'checkbox', checked: isOnList(recipe, index), 'data-act': 'toggle-ing', 'data-rid': recipe.id, 'data-index': index }),
          el('span', { class: 'qty', text: amountText(scaled(recipe, ing)) }),
          el('span', { class: 'ing-name', text: ing.item }),
        ),
      ),
    ),
  );
}

function sectionHead(title, recipe, indexes, extra) {
  const allOn = indexes.every((i) => isOnList(recipe, i));
  return el('div', { class: 'part-head' },
    el('h3', {}, title, extra || null),
    el('button', { class: 'btn btn-small btn-ghost', type: 'button', 'data-act': 'add-part', 'data-rid': recipe.id, 'data-indexes': indexes.join(','), disabled: allOn, text: allOn ? 'On list' : 'Add part' }),
  );
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
  const parts = components(r);
  const parents = usedIn(r);
  const sections = ingredientSections(r.ingredients);
  const named = sections.filter((s) => s.group);
  const allIndexes = [r.ingredients.map((_, i) => i), ...parts.map((p) => p.ingredients.map((_, i) => i))];
  const totalCount = allIndexes.flat().length;
  const onCount = r.ingredients.filter((_, i) => isOnList(r, i)).length + parts.reduce((n, p) => n + p.ingredients.filter((_, i) => isOnList(p, i)).length, 0);
  const f = recipeFactor(r);
  const n = r.nutrition;

  const parts_ = [
    el('button', { class: 'back-link', type: 'button', 'data-act': 'close-detail', text: '← All recipes' }),
    r.image ? el('img', { class: 'detail-img', src: r.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : null,
    el('div', { class: 'detail-head' },
      el('div', {},
        el('div', { class: 'rc-top' },
          el('span', { class: `chip cat cat-${r.category.toLowerCase()}`, text: r.category }),
          ...(r.tags || []).map((t) => el('button', { class: 'chip ghost tag', type: 'button', 'data-act': 'tag', 'data-tag': t, title: `Show recipes tagged ${t}`, text: t })),
          r.example ? el('span', { class: 'chip ghost', text: 'Example' }) : null,
        ),
        el('h1', { text: r.name }),
        el('p', { class: 'muted', text: metaLine(r) }),
        parents.length
          ? el('p', { class: 'linked-note' }, 'Part of ', ...parents.flatMap((p, i) => [i ? ', ' : '', el('button', { class: 'link-btn', type: 'button', 'data-act': 'select', 'data-id': p.id, text: p.name })]))
          : null,
      ),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn', type: 'button', 'data-act': 'edit', text: 'Edit' }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'read-aloud', 'aria-pressed': String(ui.reading === r.id), text: ui.reading === r.id ? 'Stop reading' : 'Read aloud' }),
        ui.confirmDelete
          ? el('span', { class: 'confirm' },
              el('span', { text: 'Delete this recipe?' }),
              el('button', { class: 'btn btn-danger', type: 'button', 'data-act': 'delete-yes', text: 'Delete' }),
              el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'delete-no', text: 'Keep' }),
            )
          : el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'delete', text: 'Delete' }),
      ),
    ),

    el('div', { class: 'scaler-row' },
      el('div', { class: 'scaler', role: 'group', 'aria-label': r.servings ? 'Servings' : 'Batch size' },
        el('span', { class: 'scaler-label', text: r.servings ? 'Servings' : 'Batch' }),
        el('button', { class: 'step-btn', type: 'button', 'data-act': 'scale-down', 'aria-label': 'Fewer', text: '−', disabled: (r.servings ? Math.round(r.servings * f) <= 1 : f <= SCALE_STEPS[0]) }),
        el('output', { class: 'scaler-value', text: servingsLabel(r) }),
        el('button', { class: 'step-btn', type: 'button', 'data-act': 'scale-up', 'aria-label': 'More', text: '+' }),
      ),
      Math.abs(f - 1) > 1e-9
        ? el('p', { class: 'hint' },
            `Amounts scaled ×${formatQty(Math.round(f * 100) / 100)}${r.servings ? ` from ${formatQty(r.servings)} servings` : ''}. Amounts written inside the steps are not. `,
            el('button', { class: 'link-btn', type: 'button', 'data-act': 'scale-reset', text: 'Reset' }))
        : null,
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
          el('button', { class: 'btn btn-small', type: 'button', 'data-act': 'add-all', disabled: onCount === totalCount || !totalCount, text: onCount === totalCount && totalCount ? 'All on list' : parts.length ? 'Add all, with parts' : 'Add all to list' }),
        ),
        ...sections.map((sec) =>
          el('div', { class: 'part' },
            named.length ? sectionHead(sec.group || 'Main', r, sec.items.map((x) => x.index)) : null,
            ingredientRows(r, sec.items),
          ),
        ),
        ...parts.map((p) =>
          el('div', { class: 'part linked' },
            sectionHead(partName(p, r), p, p.ingredients.map((_, i) => i), el('button', { class: 'link-btn small', type: 'button', 'data-act': 'select', 'data-id': p.id, text: 'Open recipe' })),
            ingredientRows(p, ingredientSections(p.ingredients).flatMap((s) => s.items)),
          ),
        ),
        el('p', { class: 'hint', text: 'Ticked items are on your grocery list.' }),
        named.length >= 2
          ? ui.confirmSplit
            ? el('div', { class: 'confirm split-confirm' },
                el('span', { text: `Make ${named.map((s) => s.group).join(', ')} their own recipes, linked to this one?` }),
                el('button', { class: 'btn btn-small btn-primary', type: 'button', 'data-act': 'split-yes', text: 'Split' }),
                el('button', { class: 'btn btn-small btn-ghost', type: 'button', 'data-act': 'split-no', text: 'Cancel' }))
            : el('button', { class: 'btn btn-small btn-ghost split-btn', type: 'button', 'data-act': 'split', text: 'Split parts into linked recipes' })
          : null,
      ),
      el('section', { class: 'steps-panel' },
        el('h2', { text: 'Method' }),
        parts.length
          ? el('p', { class: 'linked-note' }, 'Make first: ', ...parts.flatMap((p, i) => [i ? ', ' : '', el('button', { class: 'link-btn', type: 'button', 'data-act': 'select', 'data-id': p.id, text: partName(p, r) })]))
          : null,
        r.steps.length
          ? stepSections(r.steps).map((sec) =>
              el('div', { class: 'part' },
                sec.group ? el('h3', { text: sec.group }) : null,
                el('ol', { class: 'steps' }, sec.steps.map((s) => el('li', { text: s }))),
              ),
            )
          : el('p', { class: 'muted', text: 'No steps written yet.' }),
        r.notes ? el('div', { class: 'notes' }, el('h3', { text: 'Notes' }), el('p', { text: r.notes })) : null,
        r.sourceUrl ? el('p', { class: 'source' }, 'Source: ', el('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: new URL(r.sourceUrl).hostname.replace(/^www\./, '') })) : null,
      ),
    ),
  ];
  box.append(...parts_.filter(Boolean));
}

/* --------------------------------- Editor -------------------------------- */

function renderEditor() {
  const box = $('#detail');
  const { draft, id } = ui.editing;
  box.classList.add('is-open');
  document.body.classList.add('detail-open');
  const n = draft.nutrition || {};
  const others = recipesSorted().filter((o) => o.id !== id);
  const chosen = new Set(draft.components || []);
  const form = el('form', { id: 'recipe-form', class: 'editor', novalidate: true },
    el('div', { class: 'detail-head' },
      el('h1', { text: S.recipes.has(id) ? 'Edit recipe' : 'New recipe' }),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-act': 'cancel-edit', text: 'Cancel' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save recipe' }),
      ),
    ),
    draft.sourceUrl && !S.recipes.has(id) && /^https?:/.test(draft.sourceUrl) ? el('p', { class: 'hint', text: `Imported from ${new URL(draft.sourceUrl).hostname}. Check it over, then save.` }) : null,
    draft.fromPhoto && !S.recipes.has(id) ? el('p', { class: 'msg ok', text: 'Read from your photo. Check the amounts against the original, then save.' }) : null,
    el('label', { class: 'field' }, el('span', { text: 'Name' }), el('input', { id: 'f-name', name: 'name', required: true, value: draft.name || '', maxLength: 150 })),
    el('div', { class: 'row3' },
      el('label', { class: 'field' }, el('span', { text: 'Type' }),
        el('select', { id: 'f-category', name: 'category' }, CATEGORIES.map((c) => el('option', { value: c, selected: c === (draft.category || 'Dinner'), text: c })))),
      el('label', { class: 'field' }, el('span', { text: 'Total time (min)' }), el('input', { id: 'f-minutes', name: 'minutes', type: 'number', min: 0, inputMode: 'numeric', value: draft.minutes ?? '' })),
      el('label', { class: 'field' }, el('span', { text: 'Serves' }), el('input', { id: 'f-servings', name: 'servings', type: 'number', min: 0, inputMode: 'numeric', value: draft.servings ?? '' })),
    ),
    el('div', { class: 'editor-cols' },
      el('label', { class: 'field' },
        el('span', {}, 'Ingredients ', el('small', { text: 'one per line, amount first. Start a part with a line like "## Sauce"' })),
        el('textarea', { id: 'f-ingredients', name: 'ingredients', rows: 12, placeholder: '2 cups basmati rice\n1 lb chicken thighs\n\n## Raita\n1 cup yogurt\n½ cucumber, grated', value: ingredientsToText(draft.ingredients || []) }),
      ),
      el('div', { class: 'field' },
        el('span', { text: 'How it reads' }),
        el('div', { class: 'parse-preview', id: 'parse-preview' }),
      ),
    ),
    el('label', { class: 'field' },
      el('span', {}, 'Method ', el('small', { text: 'one step per line; "## Sauce" starts a part' })),
      el('textarea', { id: 'f-steps', name: 'steps', rows: 8, value: (draft.steps || []).join('\n') }),
    ),
    others.length
      ? el('fieldset', { class: 'made-with' },
          el('legend', {}, 'Made with other recipes ', el('small', { text: 'e.g. a dough, sauce or side you keep as its own recipe' })),
          el('div', { class: 'uses' },
            others.map((o) =>
              el('label', { class: 'use-chip pick' },
                el('input', { type: 'checkbox', name: 'components', value: o.id, checked: chosen.has(o.id) }),
                el('span', { text: o.name }),
              ),
            ),
          ),
        )
      : null,
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
  const box = $('#parse-preview');
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'muted', text: 'Type ingredients to see how they’ll be grouped for shopping.' }));
    return;
  }
  box.replaceChildren(
    ...ingredientSections(list).map((sec) =>
      el('div', {},
        sec.group ? el('p', { class: 'preview-part', text: sec.group }) : null,
        el('ul', {},
          sec.items.map(({ ing }) =>
            el('li', {},
              el('span', { class: 'qty', text: amountText(ing) || '·' }),
              el('span', { text: baseName(ing.item) }),
              el('span', { class: 'aisle-tag', text: AISLE_NAME[aisleOf(ing.item)] }),
            ),
          ),
        ),
      ),
    ),
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
  const servings = number(f.servings.value);
  const recipe = {
    name,
    category: f.category.value,
    minutes: number(f.minutes.value),
    servings,
    ingredients: parseIngredients(f.ingredients.value),
    steps: parseSteps(f.steps.value),
    notes: f.notes.value.trim(),
    nutrition: { calories: number(f.calories.value), protein: number(f.protein.value), carbs: number(f.carbs.value), fat: number(f.fat.value) },
    nutritionEstimated: !!draft.nutritionEstimated && (draft.nutrition?.calories ?? null) === number(f.calories.value),
    tags: f.tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    sourceUrl: f.sourceUrl.value.trim(),
    image: draft.image || '',
    components: $$('input[name="components"]:checked', e.target).map((c) => c.value),
    // Keep the chosen serving size unless the base servings changed.
    scale: old && old.servings === servings ? recipeFactor(old) : 1,
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
  ui.confirmSplit = false;
  $('#detail').replaceChildren();
  setView('recipes');
}

/* ------------------------- Split parts into recipes ------------------------ */

async function splitRecipe(r) {
  const sections = ingredientSections(r.ingredients);
  const steps = stepSections(r.steps);
  const wasOn = new Set(r.ingredients.map((_, i) => i).filter((i) => isOnList(r, i)));
  const childIds = [];
  const moves = []; // [{ recipe, index }] to put back on the grocery list
  const children = [];

  for (const sec of sections.filter((s) => s.group)) {
    const id = newId();
    const partSteps = steps.find((s) => s.group.toLowerCase() === sec.group.toLowerCase());
    const child = {
      name: `${sec.group} (${r.name})`,
      category: r.category,
      minutes: null,
      servings: r.servings ?? null,
      scale: recipeFactor(r),
      ingredients: sec.items.map(({ ing }) => ({ qty: ing.qty, unit: ing.unit, item: ing.item })),
      steps: partSteps ? partSteps.steps : [],
      notes: '',
      tags: r.tags || [],
      components: [],
      example: !!r.example,
      createdAt: Date.now(),
    };
    children.push([id, child]);
    childIds.push(id);
    sec.items.forEach(({ index }, i) => wasOn.has(index) && moves.push({ id, index: i }));
  }

  const mainItems = sections.filter((s) => !s.group).flatMap((s) => s.items);
  const keptSteps = steps.flatMap((s) => {
    if (!s.group) return s.steps;
    if (sections.some((sec) => sec.group && sec.group.toLowerCase() === s.group.toLowerCase())) return [];
    return [`## ${s.group}`, ...s.steps];
  });
  const parent = { ...stripId(r), ingredients: mainItems.map(({ ing }) => ing), steps: keptSteps, components: [...new Set([...(r.components || []), ...childIds])] };
  mainItems.forEach(({ index }, i) => wasOn.has(index) && moves.push({ id: r.id, index: i }));

  await syncRecipeOnList(r, null);
  for (const [id, child] of children) await save('recipes', id, child);
  await save('recipes', r.id, parent);
  const byRecipe = new Map();
  for (const m of moves) {
    if (!byRecipe.has(m.id)) byRecipe.set(m.id, []);
    byRecipe.get(m.id).push(m.index);
  }
  for (const [id, indexes] of byRecipe) await addToList(S.recipes.get(id), indexes);
  ui.confirmSplit = false;
  toast(`Split into ${children.length} linked recipe${children.length === 1 ? '' : 's'}.`);
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
                  el('span', { class: 'qty', text: amountText(scaled(u.recipe, u.ing)) || 'some' })),
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
  const doc = cur ? stripId(cur) : { name: titleCase(baseName(ing.item)), aisle: aisleOf(ing.item), bought: false, sources: [], addedAt: Date.now() };
  doc.sources.push({ sid: `manual-${newId()}`, rid: '', rname: '', qty: ing.qty ?? null, unit: ing.unit || '' });
  doc.bought = false;
  await save('grocery', key, doc);
}

/* ------------------------------- Add recipe ------------------------------- */

const ADD_LABELS = { photo: 'Read photo', link: 'Get recipe', paste: 'Read recipe', generate: 'Create recipe', manual: 'Start writing' };

function setAddMode(mode) {
  ui.addMode = mode;
  $$('.add-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $$('.add-pane').forEach((p) => (p.hidden = p.dataset.pane !== mode));
  $('#add-go').textContent = ADD_LABELS[mode];
  $('#add-note').textContent = mode === 'manual' ? '' : "You can check and edit everything before it's saved.";
  $('#add-error').hidden = true;
}

/** Shrink a photo so it uploads quickly and fits the AI's limits. */
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bitmap || (await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a photo this browser can open.'));
    img.src = URL.createObjectURL(file);
  }));
  // Ollama's qwen2.5vl needs memory that grows fast with the photo's size;
  // at 1600 px its process was killed partway through. 1280 px still reads
  // a cookbook page.
  const max = 1280;
  const w = src.width;
  const h = src.height;
  const k = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function renderPhotos() {
  const box = $('#photo-thumbs');
  box.replaceChildren(
    ...ui.photos.map((url, i) =>
      el('figure', { class: 'thumb' },
        el('img', { src: url, alt: `Recipe photo ${i + 1}` }),
        el('button', { class: 'thumb-x', type: 'button', 'data-act': 'remove-photo', 'data-index': i, 'aria-label': `Remove photo ${i + 1}`, text: '×' }),
      ),
    ),
  );
  $('#photo-pick-label').textContent = ui.photos.length ? (ui.photos.length < MAX_PHOTOS ? 'Add another page' : 'Up to 3 photos') : 'Take or choose a photo';
  $('#photo-input').disabled = ui.photos.length >= MAX_PHOTOS;
}

async function onPhotosPicked(e) {
  const files = [...e.target.files].slice(0, MAX_PHOTOS - ui.photos.length);
  e.target.value = '';
  for (const file of files) {
    try {
      ui.photos.push(await shrinkPhoto(file));
    } catch (err) {
      $('#add-error').textContent = err.message;
      $('#add-error').hidden = false;
    }
  }
  renderPhotos();
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
  if (mode === 'photo' && !ui.photos.length) {
    errBox.textContent = 'Take or choose a photo of the recipe first.';
    errBox.hidden = false;
    return;
  }
  const go = $('#add-go');
  go.disabled = true;
  go.textContent = { photo: 'Reading the photo…', link: 'Reading the page…', paste: 'Reading…', generate: 'Writing a recipe…' }[mode];
  try {
    const req = {
      photo: ['/api/ai/photo', { images: ui.photos }],
      link: ['/api/ai/import', { url: $('#ai-url').value.trim() }],
      paste: ['/api/ai/parse', { text: $('#ai-text').value }],
      generate: ['/api/ai/generate', { prompt: $('#ai-prompt').value }],
    }[mode];
    const { recipe } = await api(req[0], { method: 'POST', body: req[1] });
    $('#add-dialog').close();
    $('#ai-url').value = $('#ai-text').value = $('#ai-prompt').value = '';
    if (mode === 'photo') {
      ui.photos = [];
      renderPhotos();
      recipe.fromPhoto = true;
    }
    startEditing(newId(), recipe);
    if (ui.talkReply) readAloud('ai', recipe.name, recipeSpeech(recipe, { brief: true }));
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
    if (ui.talkReply) readAloud('ai', '', `Sorry. ${err.message}`);
  } finally {
    ui.talkReply = false;
    go.disabled = false;
    go.textContent = ADD_LABELS[mode];
  }
}

/* ---------------------------------- Talk ---------------------------------- */

function readAloud(id, title, text) {
  ui.reading = id;
  updateReadButton();
  speak(text, {
    onState(state) {
      const bar = $('#talk-bar');
      if (state === 'done') {
        if (ui.reading === id) ui.reading = null;
        bar.hidden = !ui.reading; // unless something else started reading
        updateReadButton();
        return;
      }
      $('#talk-bar-text').textContent = state === 'loading' ? 'Getting the voice ready…' : title ? `Reading ${title}` : 'Reading aloud';
      bar.hidden = false;
    },
  });
}

// Changes only the button, so reading doesn't redraw the recipe or the editor.
function updateReadButton() {
  const b = $('[data-act="read-aloud"]');
  if (!b) return;
  const on = !!ui.reading && ui.reading === ui.selected;
  b.textContent = on ? 'Stop reading' : 'Read aloud';
  b.setAttribute('aria-pressed', String(on));
}

function setListening(on) {
  $('#talk-btn').setAttribute('aria-pressed', String(on));
  $('#talk-btn').classList.toggle('is-listening', on);
  $('#talk-label').textContent = on ? 'Listening… tap to stop' : 'Talk';
  $('#add-go').disabled = on;
}

function startTalking() {
  if (ui.listening) return ui.listening();
  unlockAudio(); // while we still have the tap
  stopSpeaking();
  const box = $('#ai-prompt');
  const errBox = $('#add-error');
  const before = box.value;
  errBox.hidden = true;
  setListening(true);
  ui.listening = listen({
    onText: (text) => (box.value = text),
    onDone(text) {
      ui.listening = null;
      setListening(false);
      if (!text) {
        box.value = before;
        errBox.textContent = "I didn't hear anything. Tap Talk and try again.";
        errBox.hidden = false;
        return;
      }
      if (!$('#add-dialog').open) return;
      ui.talkReply = true;
      runAdd();
    },
    onError(message) {
      ui.listening = null;
      setListening(false);
      box.value = box.value || before;
      errBox.textContent = message;
      errBox.hidden = false;
    },
  });
}

/* ------------------------------- Appearance ------------------------------- */

function applyAppearance() {
  const theme = readPref('rb-theme', '');
  const accent = readPref('rb-accent', '');
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  if (accent) root.dataset.accent = accent;
  else delete root.dataset.accent;
  $$('[data-act="set-theme"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === theme)));
  $$('[data-act="set-accent"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === accent)));
}

/* --------------------------------- Account -------------------------------- */

async function openSettings() {
  $('#signed-in-as').textContent = S.user ? `Signed in as ${S.user.name} (${S.user.email}).` : '';
  applyAppearance();
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

// With PASSWORD_LOGIN=off on the server, people and passwords are managed in
// the sign-in provider (Authentik), so hide the forms for them here.
function showSignInOptions(auth) {
  if (!auth || auth.passwords !== false) return;
  $$('[data-oidc-name]').forEach((n) => (n.textContent = auth.oidc));
  $('#add-person').hidden = true;
  $('#change-password').hidden = true;
  $('#people-oidc').hidden = false;
  $('#password-oidc').hidden = false;
  if (auth.accountUrl) $('#oidc-account').href = auth.accountUrl;
  else $('#oidc-account').replaceWith('Change it there.');
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
    name: 'Chicken tikka with mint raita', category: 'Dinner', minutes: 50, servings: 4, tags: ['pakistani', 'grill'],
    ingredients: parseIngredients('## Marinade\n1 1/2 lb chicken thighs, cubed\n1 cup yogurt\n1 tbsp ginger garlic paste\n2 tsp tikka masala\n1 tbsp lemon juice\n1 tsp salt\n\n## Mint raita\n1 cup yogurt\n1/2 cucumber, grated\n2 tbsp mint, chopped\n1/4 tsp cumin powder\n1 pinch salt'),
    steps: parseSteps('## Marinade\nMix the yogurt, ginger garlic paste, tikka masala, lemon juice and salt.\nCoat the chicken and marinate for at least 30 minutes.\nThread onto skewers and grill or bake at 230°C for 15 to 18 minutes, turning once.\n## Mint raita\nSqueeze the grated cucumber dry.\nStir everything together and chill until serving.'),
    notes: 'Example recipe with two parts. Try "Split parts into linked recipes".',
    nutrition: { calories: 360, protein: 41, carbs: 10, fat: 16 }, nutritionEstimated: true,
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
  const target = t.dataset.rid ? S.recipes.get(t.dataset.rid) : r;

  if (act === 'select') {
    ui.selected = t.dataset.id;
    ui.editing = null;
    ui.confirmDelete = false;
    ui.confirmSplit = false;
    render();
    if (matchMedia('(max-width: 800px)').matches) window.scrollTo({ top: 0 });
  } else if (act === 'close-detail') {
    ui.selected = null;
    render();
  } else if (act === 'filter') {
    ui.filter = t.dataset.cat;
    writePref('rb-filter', ui.filter);
    renderRecipes();
  } else if (act === 'tag') {
    $('#recipe-search').value = t.dataset.tag;
    ui.filter = '';
    writePref('rb-filter', '');
    renderRecipes();
  } else if (act === 'edit' && r) {
    startEditing(r.id, r);
  } else if (act === 'read-aloud' && r) {
    if (ui.reading === r.id) stopSpeaking();
    else {
      unlockAudio();
      readAloud(r.id, r.name, recipeSpeech(r));
    }
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
    // Unlink it from recipes that were made with it.
    for (const p of usedIn(r)) await save('recipes', p.id, { ...stripId(p), components: p.components.filter((id) => id !== r.id) });
    toast(`Deleted ${r.name}.`);
  } else if (act === 'scale-up' && r) {
    setScale(r, nextScale(r, 1));
  } else if (act === 'scale-down' && r) {
    setScale(r, nextScale(r, -1));
  } else if (act === 'scale-reset' && r) {
    setScale(r, 1);
  } else if (act === 'split') {
    ui.confirmSplit = true;
    renderDetail();
  } else if (act === 'split-no') {
    ui.confirmSplit = false;
    renderDetail();
  } else if (act === 'split-yes' && r) {
    t.disabled = true;
    await splitRecipe(r);
  } else if (act === 'toggle-ing' && target) {
    const index = Number(t.dataset.index);
    const ing = target.ingredients[index];
    await setUses(keyOf(ing.item), [{ recipe: target, index, ing }], t.checked);
  } else if (act === 'add-part' && target) {
    const indexes = t.dataset.indexes.split(',').filter(Boolean).map(Number);
    const n = await addToList(target, indexes);
    toast(`Added ${n} item${n === 1 ? '' : 's'} to the grocery list.`);
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
    if (g) await save('grocery', g.id, { ...stripId(g), bought: t.checked });
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
  } else if (act === 'remove-photo') {
    ui.photos.splice(Number(t.dataset.index), 1);
    renderPhotos();
  } else if (act === 'set-theme') {
    writePref('rb-theme', t.dataset.value);
    applyAppearance();
  } else if (act === 'set-accent') {
    writePref('rb-accent', t.dataset.value);
    applyAppearance();
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
  renderPhotos();
  $('#add-dialog').showModal();
});
$$('.add-tab').forEach((tab) => tab.addEventListener('click', () => setAddMode(tab.dataset.mode)));
$('#add-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  runAdd();
});
$('#photo-input').addEventListener('change', onPhotosPicked);
$('#talk-row').hidden = !canListen();
$('#talk-btn').addEventListener('click', startTalking);
$('#add-dialog').addEventListener('close', () => ui.listening?.());
$('#talk-stop').addEventListener('click', stopSpeaking);

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

/* -------------------------------- AI status ------------------------------- */

const AI_LABELS = { ready: 'AI ready', down: 'AI down', off: 'AI off', checking: 'Checking the AI…' };
let aiTimer;

const VOICE_LABELS = { ready: 'AI voice ready', down: 'AI voice down', off: 'AI voice off', checking: 'Checking the AI voice…' };

function showStatus(id, labels, state, detail = '') {
  const el = $(`#${id}`);
  el.dataset.state = state;
  el.title = detail ? `${labels[state]}: ${detail}` : labels[state];
  $(`#${id}-text`).textContent = el.title;
  el.hidden = false;
}

function showAiStatus(state, detail = '') {
  showStatus('ai-status', AI_LABELS, state, detail);
}

function showVoiceStatus(state, detail = '') {
  // Back up: let "Read aloud" try it again straight away.
  if (state === 'ready' && $('#voice-status').dataset.state !== 'ready') retryServerVoice();
  showStatus('voice-status', VOICE_LABELS, state, detail);
}

// Asks the server every minute while the page is open; the server keeps its
// answer for 30 seconds, so several open tabs don't pile up checks.
async function checkAi() {
  clearTimeout(aiTimer);
  try {
    const { state, detail, voice, version } = await api('/api/ai/status');
    reloadIfUpdated(version);
    showAiStatus(state, detail);
    if (voice) showVoiceStatus(voice.state, voice.detail);
  } catch (err) {
    showAiStatus('down', `couldn't ask Recipe Board (${err.message})`);
    showVoiceStatus('down', `couldn't ask Recipe Board (${err.message})`);
  }
  if (document.visibilityState === 'visible') aiTimer = setTimeout(checkAi, 60_000);
}

$('#ai-status').addEventListener('click', () => {
  toast($('#ai-status').title);
  showAiStatus('checking');
  checkAi();
});
$('#voice-status').addEventListener('click', () => {
  toast($('#voice-status').title);
  showVoiceStatus('checking');
  checkAi();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user) checkAi();
  else clearTimeout(aiTimer);
});

/* ------------------------------- App updates ------------------------------ */

// A phone can keep this page open for days, for example when it is opened
// from the home page app, so it would keep running old code after a deploy.
// The status check above carries the server's version; when it changes, reload
// once nothing would be lost: not while editing a recipe or adding one.
let loadedVersion = null;
let updateWaiting = false;

function reloadIfUpdated(version) {
  if (!version) return;
  loadedVersion ??= version;
  if (version !== loadedVersion) updateWaiting = true;
  if (updateWaiting && !ui.editing && !$('#add-dialog').open) location.reload();
}

// Safari can show this page from its back/forward cache without running it again.
addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

/* ---------------------------------- Start --------------------------------- */

(async () => {
  applyAppearance();
  try {
    const { user, auth } = await api('/api/session');
    if (!user) {
      location.href = '/login';
      return;
    }
    S.user = user;
    showSignInOptions(auth);
    $('#open-settings').hidden = false;
    showAiStatus('checking');
    checkAi();
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
