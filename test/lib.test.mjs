import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredient, keyOf, aisleOf, combineAmounts, formatQty, sectionHeader, parseIngredients, parseSteps, ingredientsToText, ingredientSections, stepSections, scaleAmount, recipeFactor } from '../public/assets/lib.js';
import { isoMinutes, recipeFromSchema, schemaRecipeFromHtml } from '../src/ai.js';

test('parses quantities, units and items', () => {
  assert.deepEqual(parseIngredient('2 1/2 cups flour, sifted'), { qty: 2.5, unit: 'cup', item: 'flour, sifted' });
  assert.deepEqual(parseIngredient('200g basmati rice'), { qty: 200, unit: 'g', item: 'basmati rice' });
  assert.deepEqual(parseIngredient('½ tsp salt'), { qty: 0.5, unit: 'tsp', item: 'salt' });
  assert.deepEqual(parseIngredient('3 eggs'), { qty: 3, unit: '', item: 'eggs' });
  assert.deepEqual(parseIngredient('salt to taste'), { qty: null, unit: '', item: 'salt to taste' });
  assert.deepEqual(parseIngredient('1 cup of milk'), { qty: 1, unit: 'cup', item: 'milk' });
  assert.deepEqual(parseIngredient('2-3 green chilies'), { qty: 2, unit: '', item: 'green chilies' });
  assert.deepEqual(parseIngredient('1 inch ginger'), { qty: 1, unit: 'inch', item: 'ginger' });
  assert.equal(parseIngredient('   '), null);
});

test('same ingredient gets the same grocery key', () => {
  assert.equal(keyOf('Eggs'), keyOf('egg'));
  assert.equal(keyOf('tomatoes, chopped'), keyOf('Tomato'));
  assert.equal(keyOf('cherries'), keyOf('cherry'));
  assert.equal(keyOf('green chilies'), keyOf('green chili'));
  assert.equal(keyOf('salt to taste'), keyOf('salt'));
  assert.equal(keyOf('1 large onion'.slice(2)), keyOf('onions'));
  assert.match(keyOf('ادرک'), /^i-/);
});

test('sorts ingredients into aisles', () => {
  assert.equal(aisleOf('black pepper'), 'spices');
  assert.equal(aisleOf('red bell pepper'), 'produce');
  assert.equal(aisleOf('eggplant'), 'produce');
  assert.equal(aisleOf('eggs'), 'dairy');
  assert.equal(aisleOf('peanut butter'), 'pantry');
  assert.equal(aisleOf('chicken thighs'), 'meat');
  assert.equal(aisleOf('olive oil'), 'spices');
  assert.equal(aisleOf('mystery thing'), 'other');
});

test('adds up amounts that share a unit', () => {
  assert.equal(combineAmounts([{ qty: 1, unit: 'cup' }, { qty: 0.5, unit: 'cup' }, { qty: 2, unit: 'tbsp' }]), '1½ cup + 2 tbsp');
  assert.equal(formatQty(0.333), '⅓');
});

test('reads schema.org recipes from a page', () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"Daal &amp; Rice","recipeYield":["4","4 servings"],"totalTime":"PT1H5M","recipeCategory":"Dinner","recipeIngredient":["1 cup masoor dal","2 cups water"],"recipeInstructions":[{"@type":"HowToSection","itemListElement":[{"@type":"HowToStep","text":"Rinse the dal."},{"@type":"HowToStep","text":"Boil until soft."}]}],"nutrition":{"calories":"310 kcal","proteinContent":"18 g"},"image":{"url":"https://example.com/d.jpg"}}]}</script></html>`;
  const r = recipeFromSchema(schemaRecipeFromHtml(html), 'https://example.com/daal');
  assert.equal(r.name, 'Daal & Rice');
  assert.equal(r.servings, 4);
  assert.equal(r.minutes, 65);
  assert.equal(r.category, 'Dinner');
  assert.deepEqual(r.steps, ['Rinse the dal.', 'Boil until soft.']);
  assert.equal(r.ingredients[0].item, 'masoor dal');
  assert.equal(r.nutrition.calories, 310);
  assert.equal(r.image, 'https://example.com/d.jpg');
  assert.equal(isoMinutes('PT45M'), 45);
});

test('recognizes the start of a recipe part', () => {
  assert.equal(sectionHeader('## Marinade'), 'Marinade');
  assert.equal(sectionHeader('For the sauce:'), 'Sauce');
  assert.equal(sectionHeader('RAITA:'), 'Raita');
  assert.equal(sectionHeader('2 cups flour'), null);
  assert.equal(sectionHeader('1 tsp salt:'), null);
});

test('ingredients and steps keep their parts', () => {
  const ings = parseIngredients('1 lb chicken\n\nFor the raita:\n1 cup yogurt\n½ cucumber');
  assert.deepEqual(ings.map((i) => i.group || ''), ['', 'Raita', 'Raita']);
  assert.deepEqual(ingredientSections(ings).map((s) => [s.group, s.items.map((x) => x.index)]), [['', [0]], ['Raita', [1, 2]]]);
  assert.deepEqual(parseIngredients(ingredientsToText(ings)).map((i) => i.group || ''), ['', 'Raita', 'Raita']);
  const steps = parseSteps('1. Marinate the chicken.\n## Raita\nStep 2: Mix yogurt.');
  assert.deepEqual(steps, ['Marinate the chicken.', '## Raita', 'Mix yogurt.']);
  assert.deepEqual(stepSections(steps), [{ group: '', steps: ['Marinate the chicken.'] }, { group: 'Raita', steps: ['Mix yogurt.'] }]);
});

test('scaling moves to bigger units', () => {
  assert.deepEqual(scaleAmount(2, 'tsp', 2), { qty: 1.333, unit: 'tbsp' });
  assert.deepEqual(scaleAmount(2, 'tbsp', 4), { qty: 0.5, unit: 'cup' });
  assert.deepEqual(scaleAmount(600, 'g', 2), { qty: 1.2, unit: 'kg' });
  assert.deepEqual(scaleAmount(3, '', 0.5), { qty: 1.5, unit: '' });
  assert.deepEqual(scaleAmount(0.25, 'tsp', 1.25), { qty: 0.333, unit: 'tsp' });
  assert.deepEqual(scaleAmount(250, 'g', 1.25), { qty: 312.5, unit: 'g' });
  assert.deepEqual(scaleAmount(null, '', 3), { qty: null, unit: '' });
  assert.equal(recipeFactor({ scale: 1.5 }), 1.5);
  assert.equal(recipeFactor({}), 1);
});

test('eighths survive a round trip', () => {
  assert.equal(formatQty(0.375), '⅜');
  assert.deepEqual(parseIngredient('⅜ tsp cumin'), { qty: 0.375, unit: 'tsp', item: 'cumin' });
  assert.deepEqual(parseIngredient('1⅝ cups milk'), { qty: 1.625, unit: 'cup', item: 'milk' });
});

test('reads recipes aloud in words', async () => {
  const { recipeSpeech, speakable, spokenIngredient, speechChunks } = await import('../public/assets/lib.js');
  assert.equal(spokenIngredient(parseIngredient('1/2 tsp salt')), 'half a teaspoon of salt');
  assert.equal(spokenIngredient(parseIngredient('1 1/2 lb chicken')), '1 and a half pounds of chicken');
  assert.equal(spokenIngredient(parseIngredient('3 eggs')), '3 eggs');
  assert.equal(spokenIngredient(parseIngredient('2 bunch cilantro')), '2 bunches of cilantro');
  assert.equal(speakable('Bake at 230°C for 15 min, add 1/2 tsp cumin'), 'Bake at 230 degrees Celsius for 15 minutes, add half a teaspoon cumin');
  const r = { name: 'Tikka', servings: 4, minutes: 90, ingredients: parseIngredients('## Marinade\n1 cup yogurt\n1 tsp salt'), steps: parseSteps('## Marinade\nMix\nRest 30 min.'), notes: '' };
  assert.equal(recipeSpeech(r, { brief: true }), "Here's Tikka. It serves 4 and takes about 1 hour 30 minutes. You'll need 1 cup of yogurt and 1 teaspoon of salt. Have a look, and save it if you like it.");
  assert.match(recipeSpeech(r), /For the Marinade: 1 cup of yogurt and 1 teaspoon of salt\. Method\. For the Marinade\. Step 1\. Mix\. Step 2\. Rest 30 minutes\./);
  const chunks = speechChunks('One. '.repeat(200), { first: 50, max: 120 });
  assert.ok(chunks[0].length <= 50 && chunks.every((c) => c.length <= 120));
  assert.equal(chunks.join(' '), 'One. '.repeat(200).trim());
});

test('builds Index-TTS inputs from the WebUI description', async () => {
  const { buildInputs, readEvents } = await import('../server/tts.mjs');
  const params = [
    { parameter_name: 'emo_control_method', component: 'Radio', parameter_has_default: true, parameter_default: 'same' },
    { parameter_name: 'prompt', component: 'Audio', parameter_has_default: false },
    { parameter_name: 'text', component: 'Textbox', parameter_has_default: false },
    { parameter_name: 'emo_ref_path', component: 'Audio', parameter_has_default: false },
    { parameter_name: 'lang_choice', component: 'Dropdown', parameter_has_default: true, parameter_default: 'ZH' },
    { parameter_name: 'param_5', component: 'Slider', parameter_has_default: true, parameter_default: 0.8 },
  ];
  assert.deepEqual(buildInputs(params, 'Hello', '/tmp/v.wav'), ['same', { path: '/tmp/v.wav', meta: { _type: 'gradio.FileData' } }, 'Hello', null, 'EN', 0.8]);
  const file = { path: '/tmp/out.wav' };
  assert.deepEqual(readEvents(`event: generating\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([file])}\n\n`), [file]);
  assert.throws(() => readEvents('event: error\ndata: "CUDA out of memory"\n\n'), /CUDA out of memory/);
  assert.throws(() => readEvents('event: heartbeat\ndata: null\n\n'), /stopped before/);
});
