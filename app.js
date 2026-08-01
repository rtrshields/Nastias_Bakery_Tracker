// ---------- Constants ----------
const STORAGE_KEY = 'nastiaBakeryData';

const UNIT_DEFS = {
  weight: { units: { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } },
  volume: { units: { mL: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 } },
  count: { units: { each: 1 } }
};

const CATEGORY_COLORS = ['var(--rose)', 'var(--blue)', 'var(--accent-dark)', 'var(--blue-light)', 'var(--rose-dark)', 'var(--blue-dark)'];
function categoryHash(category, seed) {
  const str = seed + String(category || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}
function categoryColor(category) {
  return CATEGORY_COLORS[categoryHash(category, 'color') % CATEGORY_COLORS.length];
}
const CARD_SUITS = ['♥', '♦', '♣', '♠'];
function categorySuit(category) {
  return CARD_SUITS[categoryHash(category, 'suit') % CARD_SUITS.length];
}
const CATEGORY_EMOJI = { dessert: '🍰', savoury: '🥐', savory: '🥐', bread: '🍞', pastry: '🥮', cookie: '🍪', cake: '🎂' };
function categoryEmoji(category) {
  return CATEGORY_EMOJI[String(category || '').trim().toLowerCase()] || '🧁';
}

// ---------- State ----------
// A function, not a shared object — Object.assign only shallow-copies, so a constant
// object here would let every push() onto state.ingredients etc. silently mutate the
// "empty defaults" template too, since both would point at the same array.
function getDefaultState() {
  return { ingredients: [], recipes: [], bakeLog: [], purchases: [], adjustments: [], tombstones: [] };
}
let state = getDefaultState();
let currentView = 'home';
let currentDetailRecipeId = null;
let editingRecipeId = null;
let inventoryEditingId = null;
let saveIndicatorTimeout = null;

// ---------- Utilities ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function formatMoney(n) {
  if (!isFinite(n)) n = 0;
  return '$' + n.toFixed(2);
}
function formatUnitCost(n) {
  if (!isFinite(n)) n = 0;
  return Math.abs(n) < 1 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
}
function canonicalUnitLabel(category) {
  return { weight: 'g', volume: 'mL', count: 'each' }[category] || '';
}
function formatQty(category, qty) {
  qty = qty || 0;
  if (category === 'weight') {
    return Math.abs(qty) >= 1000 ? round2(qty / 1000) + ' kg' : round2(qty) + ' g';
  }
  if (category === 'volume') {
    return Math.abs(qty) >= 1000 ? round2(qty / 1000) + ' L' : round2(qty) + ' mL';
  }
  return round2(qty) + ' each';
}
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function toCanonical(category, unit, qty) {
  const factor = UNIT_DEFS[category].units[unit];
  return (qty || 0) * (factor == null ? 1 : factor);
}
function inferCategoryFromUnit(unit) {
  for (const cat in UNIT_DEFS) {
    if (UNIT_DEFS[cat].units[unit] != null) return cat;
  }
  return 'weight';
}

// ---------- Data lookups ----------
function findIngredient(name) {
  const n = String(name || '').trim().toLowerCase();
  return state.ingredients.find(i => i.name.toLowerCase() === n);
}
function findIngredientById(id) {
  return state.ingredients.find(i => i.id === id);
}
function findRecipeById(id) {
  return state.recipes.find(r => r.id === id);
}
function currentVersion(recipe) {
  return recipe.versions[recipe.versions.length - 1];
}
// Cost precedence for a recipe line:
//  1. Ingredient is currently in stock (on hand > 0) -> use the live inventory price.
//  2. Ingredient is depleted or was never purchased, and a backup cost was entered -> use that.
//  3. Depleted, no backup cost entered -> fall back to the last known inventory price.
//  4. Never purchased, no backup cost entered -> no cost known ($0).
function getLineCostInfo(line) {
  const ing = findIngredient(line.ingredientName);
  const hasKnownCost = ing && typeof ing.unitCost === 'number';
  if (hasKnownCost && ing.onHandQty > 0) {
    return { cost: line.qtyCanonical * ing.unitCost, source: 'inventory' };
  }
  if (line.fallbackCost != null) {
    return { cost: line.fallbackCost, source: 'manual' };
  }
  if (hasKnownCost) {
    return { cost: line.qtyCanonical * ing.unitCost, source: 'last-known' };
  }
  return { cost: 0, source: 'none' };
}
function computeLineCost(line) {
  return getLineCostInfo(line).cost;
}
const COST_SOURCE_LABELS = {
  inventory: 'in stock',
  manual: 'your estimate',
  'last-known': 'last known price — out of stock',
  none: 'no cost yet'
};
function computeRecipeCost(version) {
  return version.lines.reduce((sum, l) => sum + computeLineCost(l), 0);
}

// ---------- Persistence ----------
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = Object.assign({}, getDefaultState(), parsed);
    }
  } catch (e) {
    console.error('Failed to load saved data', e);
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const el = document.getElementById('saved-indicator');
  el.classList.add('show');
  clearTimeout(saveIndicatorTimeout);
  saveIndicatorTimeout = setTimeout(() => el.classList.remove('show'), 1400);
}

// ---------- Navigation ----------
const SECTIONS = ['home', 'inventory', 'recipes', 'recipe-detail', 'bakelog'];
function showView(name) {
  SECTIONS.forEach(s => {
    document.getElementById('view-' + s).classList.toggle('hidden', s !== name);
  });
  currentView = name;
}
function setActiveNav(section) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
}

// ---------- Modal management ----------
let confirmResolve = null;
function openModal(id) {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}
// Resolves true (ok), false (cancel), or 'alt' (the optional third choice) when provided.
function confirmDialog(message, title, okLabel, altLabel) {
  document.getElementById('confirm-title').textContent = title || 'Are you sure?';
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-ok').textContent = okLabel || 'Delete';
  const altBtn = document.getElementById('confirm-alt');
  altBtn.hidden = !altLabel;
  altBtn.textContent = altLabel || '';
  openModal('modal-confirm');
  return new Promise(resolve => { confirmResolve = resolve; });
}
function wireConfirmModal() {
  document.getElementById('confirm-ok').addEventListener('click', () => {
    closeModal();
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
  });
  document.getElementById('confirm-alt').addEventListener('click', () => {
    closeModal();
    if (confirmResolve) { confirmResolve('alt'); confirmResolve = null; }
  });
  document.getElementById('confirm-cancel').addEventListener('click', () => {
    closeModal();
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });
}

// ---------- Toasts ----------
function showToast(message, type) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

// ---------- Datalist / unit dropdowns ----------
function updateIngredientDatalist() {
  document.getElementById('ingredient-names').innerHTML =
    state.ingredients.map(i => `<option value="${escapeHtml(i.name)}"></option>`).join('');
}
function getRecipeCategories() {
  const defaults = ['Dessert', 'Savoury', 'Bread'];
  const used = state.recipes.map(r => r.category).filter(Boolean);
  return Array.from(new Set([...defaults, ...used]));
}
function getYieldLabels() {
  const defaults = ['cookies', 'servings', 'slices', 'loaves', 'muffins', 'cupcakes'];
  const used = state.recipes.flatMap(r => r.versions.map(v => v.yieldLabel)).filter(Boolean);
  return Array.from(new Set([...defaults, ...used]));
}
function updateRecipeDatalists() {
  document.getElementById('recipe-categories').innerHTML =
    getRecipeCategories().map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
  document.getElementById('yield-labels').innerHTML =
    getYieldLabels().map(y => `<option value="${escapeHtml(y)}"></option>`).join('');
}
function populateUnitSelect(selectEl, category, selectedUnit) {
  const units = Object.keys(UNIT_DEFS[category].units);
  selectEl.innerHTML = units.map(u => `<option value="${u}">${u}</option>`).join('');
  selectEl.value = selectedUnit && units.includes(selectedUnit) ? selectedUnit : units[0];
}

// ---------- Invoice modal ----------
function openInvoiceModal() {
  document.getElementById('form-invoice').reset();
  const categorySelect = document.getElementById('inv-category');
  categorySelect.disabled = false;
  categorySelect.value = 'weight';
  populateUnitSelect(document.getElementById('inv-unit'), 'weight');
  document.getElementById('inv-existing-hint').textContent = '';
  updateIngredientDatalist();
  openModal('modal-invoice');
}
function wireInvoiceModal() {
  document.getElementById('inv-ingredient-name').addEventListener('input', () => {
    const name = document.getElementById('inv-ingredient-name').value;
    const match = findIngredient(name);
    const categorySelect = document.getElementById('inv-category');
    const hint = document.getElementById('inv-existing-hint');
    if (match) {
      categorySelect.value = match.category;
      categorySelect.disabled = true;
      populateUnitSelect(document.getElementById('inv-unit'), match.category);
      hint.textContent = `Existing ingredient — currently ${formatQty(match.category, match.onHandQty)} on hand at ${formatUnitCost(match.unitCost)}/${canonicalUnitLabel(match.category)}.`;
    } else {
      categorySelect.disabled = false;
      hint.textContent = '';
    }
  });
  document.getElementById('inv-category').addEventListener('change', () => {
    populateUnitSelect(document.getElementById('inv-unit'), document.getElementById('inv-category').value);
  });
  document.getElementById('form-invoice').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('inv-ingredient-name').value.trim();
    const category = document.getElementById('inv-category').value;
    const unit = document.getElementById('inv-unit').value;
    const qty = parseFloat(document.getElementById('inv-qty').value);
    const price = parseFloat(document.getElementById('inv-price').value);
    if (!name || !qty || qty <= 0 || isNaN(price) || price < 0) {
      showToast('Please fill in a valid ingredient, quantity, and price.', 'error');
      return;
    }
    const qtyCanonical = toCanonical(category, unit, qty);
    const costPerCanonical = qtyCanonical > 0 ? price / qtyCanonical : 0;
    let ing = findIngredient(name);
    const today = todayISO();
    if (ing) {
      const newOnHand = ing.onHandQty + qtyCanonical;
      ing.unitCost = newOnHand !== 0
        ? (ing.onHandQty * ing.unitCost + qtyCanonical * costPerCanonical) / newOnHand
        : costPerCanonical;
      ing.onHandQty = newOnHand;
      ing.lastPurchaseDate = today;
    } else {
      ing = { id: uid(), name, category, onHandQty: qtyCanonical, unitCost: costPerCanonical, lastPurchaseDate: today };
      state.ingredients.push(ing);
    }
    state.purchases.push({ id: uid(), createdAt: Date.now(), date: today, ingredientName: name, qty, unit, price });
    saveState();
    closeModal();
    showToast(`Logged purchase: ${name}`, 'success');
    renderInventory();
    renderHome();
    if (currentView === 'recipe-detail' && currentDetailRecipeId) renderRecipeDetail(currentDetailRecipeId);
  });
}

// ---------- Recipe modal ----------
function addRecipeLine(prefill) {
  const container = document.getElementById('rec-lines');
  const div = document.createElement('div');
  div.className = 'recipe-line';
  div.innerHTML = `
    <label>Ingredient
      <input type="text" class="line-name" list="ingredient-names" value="${escapeHtml(prefill && prefill.ingredientName || '')}" placeholder="e.g. Butter" required>
    </label>
    <label>Category
      <select class="line-category">
        <option value="weight">Weight</option>
        <option value="volume">Volume</option>
        <option value="count">Count</option>
      </select>
    </label>
    <label>Qty
      <input type="number" class="line-qty" min="0" step="any" value="${prefill ? prefill.qty : ''}" required>
    </label>
    <label>Unit
      <select class="line-unit"></select>
    </label>
    <label class="fallback-cost" title="Used automatically once this ingredient is out of stock or hasn't been purchased yet">Backup cost ($)
      <input type="number" class="line-fallback" min="0" step="0.01" value="${prefill && prefill.fallbackCost != null ? prefill.fallbackCost : ''}">
    </label>
    <button type="button" class="btn btn-danger line-remove">✕</button>
  `;
  container.appendChild(div);

  const categorySelect = div.querySelector('.line-category');
  const unitSelect = div.querySelector('.line-unit');
  const category = (prefill && prefill.category) || 'weight';
  categorySelect.value = category;
  populateUnitSelect(unitSelect, category, prefill && prefill.unit);

  categorySelect.addEventListener('change', () => {
    populateUnitSelect(unitSelect, categorySelect.value);
    updateRecipeCostPreview();
  });
  div.querySelector('.line-remove').addEventListener('click', () => {
    div.remove();
    updateRecipeCostPreview();
  });
  div.querySelector('.line-name').addEventListener('input', () => {
    const match = findIngredient(div.querySelector('.line-name').value);
    if (match) {
      categorySelect.value = match.category;
      populateUnitSelect(unitSelect, match.category);
    }
    updateRecipeCostPreview();
  });
}
function readLineFromDom(div) {
  const name = div.querySelector('.line-name').value.trim();
  const category = div.querySelector('.line-category').value;
  const unit = div.querySelector('.line-unit').value;
  const qty = parseFloat(div.querySelector('.line-qty').value) || 0;
  const fallbackRaw = div.querySelector('.line-fallback').value;
  const fallbackCost = fallbackRaw === '' ? undefined : parseFloat(fallbackRaw);
  return { ingredientName: name, category, unit, qty, qtyCanonical: toCanonical(category, unit, qty), fallbackCost };
}
function collectRecipeLines() {
  return Array.from(document.querySelectorAll('#rec-lines .recipe-line'))
    .map(readLineFromDom)
    .filter(l => l.ingredientName !== '');
}

// ---------- Recipe steps builder ----------
function addStepRow(text) {
  const container = document.getElementById('rec-steps');
  const div = document.createElement('div');
  div.className = 'step-row';
  div.innerHTML = `
    <span class="step-number">1</span>
    <textarea class="step-text" rows="1" placeholder="e.g. Cream butter and sugar until fluffy">${escapeHtml(text || '')}</textarea>
    <div class="step-actions">
      <button type="button" class="btn-icon step-up" title="Move up">↑</button>
      <button type="button" class="btn-icon step-down" title="Move down">↓</button>
      <button type="button" class="btn-icon step-remove" title="Remove step">✕</button>
    </div>
  `;
  container.appendChild(div);
  const textarea = div.querySelector('.step-text');
  const maxHeight = 200;
  const autoGrow = () => {
    textarea.style.height = 'auto';
    const capped = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = capped + 'px';
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', autoGrow);
  autoGrow();
  div.querySelector('.step-remove').addEventListener('click', () => { div.remove(); renumberSteps(); });
  div.querySelector('.step-up').addEventListener('click', () => {
    const prev = div.previousElementSibling;
    if (prev) container.insertBefore(div, prev);
    renumberSteps();
  });
  div.querySelector('.step-down').addEventListener('click', () => {
    const next = div.nextElementSibling;
    if (next) container.insertBefore(next, div);
    renumberSteps();
  });
  renumberSteps();
}
function renumberSteps() {
  const rows = document.querySelectorAll('#rec-steps .step-row');
  rows.forEach((row, i) => {
    row.querySelector('.step-number').textContent = i + 1;
    row.querySelector('.step-up').disabled = i === 0;
    row.querySelector('.step-down').disabled = i === rows.length - 1;
  });
}
function collectSteps() {
  return Array.from(document.querySelectorAll('#rec-steps .step-text'))
    .map(input => input.value.trim())
    .filter(Boolean);
}
function updateRecipeCostPreview() {
  const lines = collectRecipeLines();
  const yieldQty = parseFloat(document.getElementById('rec-yield-qty').value) || 0;
  const yieldLabel = document.getElementById('rec-yield-label').value.trim() || 'item';
  const lineInfos = lines.map(getLineCostInfo);
  const total = lineInfos.reduce((s, info) => s + info.cost, 0);
  const perItem = yieldQty > 0 ? total / yieldQty : 0;
  const notLive = lineInfos.some(info => info.source !== 'inventory');
  document.getElementById('rec-cost-preview').innerHTML =
    `<span class="big">Total: ${formatMoney(total)}</span> • ${formatMoney(perItem)} / ${escapeHtml(yieldLabel)}` +
    (notLive ? ' <span class="warn">(some ingredients aren\'t using a current inventory price)</span>' : '');
}
function openRecipeModal(recipeId) {
  editingRecipeId = recipeId;
  document.getElementById('form-recipe').reset();
  document.getElementById('rec-lines').innerHTML = '';
  document.getElementById('rec-steps').innerHTML = '';
  if (recipeId) {
    const recipe = findRecipeById(recipeId);
    const v = currentVersion(recipe);
    document.getElementById('recipe-modal-title').textContent = 'Edit Recipe';
    document.getElementById('rec-name').value = recipe.name;
    document.getElementById('rec-category').value = recipe.category;
    document.getElementById('rec-yield-qty').value = v.yieldQty;
    document.getElementById('rec-yield-label').value = v.yieldLabel;
    document.getElementById('rec-notes').value = v.notes || '';
    document.getElementById('rec-prep-minutes').value = v.prepMinutes != null ? v.prepMinutes : '';
    document.getElementById('rec-bake-minutes').value = v.bakeMinutes != null ? v.bakeMinutes : '';
    document.getElementById('rec-oven-temp').value = v.ovenTemp != null ? v.ovenTemp : '';
    document.getElementById('rec-oven-unit').value = v.ovenTempUnit || 'F';
    v.lines.forEach(line => addRecipeLine(line));
    (v.steps || []).forEach(step => addStepRow(step));
    if (!v.steps || v.steps.length === 0) addStepRow();
  } else {
    document.getElementById('recipe-modal-title').textContent = 'Add Recipe';
    document.getElementById('rec-oven-unit').value = 'F';
    addRecipeLine();
    addStepRow();
  }
  updateIngredientDatalist();
  updateRecipeDatalists();
  updateRecipeCostPreview();
  openModal('modal-recipe');
}
function wireRecipeModal() {
  document.getElementById('rec-add-line').addEventListener('click', () => {
    addRecipeLine();
    updateRecipeCostPreview();
  });
  document.getElementById('rec-add-step').addEventListener('click', () => addStepRow());
  document.getElementById('form-recipe').addEventListener('input', updateRecipeCostPreview);
  document.getElementById('form-recipe').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('rec-name').value.trim();
    const category = document.getElementById('rec-category').value.trim();
    const yieldQty = parseFloat(document.getElementById('rec-yield-qty').value) || 0;
    const yieldLabel = document.getElementById('rec-yield-label').value.trim();
    const notes = document.getElementById('rec-notes').value.trim();
    const prepMinutesRaw = document.getElementById('rec-prep-minutes').value;
    const bakeMinutesRaw = document.getElementById('rec-bake-minutes').value;
    const ovenTempRaw = document.getElementById('rec-oven-temp').value;
    const prepMinutes = prepMinutesRaw === '' ? null : parseFloat(prepMinutesRaw);
    const bakeMinutes = bakeMinutesRaw === '' ? null : parseFloat(bakeMinutesRaw);
    const ovenTemp = ovenTempRaw === '' ? null : parseFloat(ovenTempRaw);
    const ovenTempUnit = document.getElementById('rec-oven-unit').value;
    const steps = collectSteps();
    const lines = collectRecipeLines();
    if (lines.length === 0) {
      showToast('Add at least one ingredient.', 'error');
      return;
    }
    const today = todayISO();
    // name/category are snapshotted onto the version itself (not just the recipe) so a
    // merge can tell what they were at each edit, instead of one device's rename silently
    // winning over another's just because its export was imported last.
    const versionData = { name, category, yieldQty, yieldLabel, lines, notes, prepMinutes, bakeMinutes, ovenTemp, ovenTempUnit, steps };
    if (editingRecipeId) {
      const recipe = findRecipeById(editingRecipeId);
      const nextVersionNumber = currentVersion(recipe).versionNumber + 1;
      recipe.name = name;
      recipe.category = category;
      recipe.versions.push(Object.assign({ id: uid(), createdAt: Date.now(), versionNumber: nextVersionNumber, date: today }, versionData));
    } else {
      state.recipes.push({
        id: uid(), name, category,
        versions: [Object.assign({ id: uid(), createdAt: Date.now(), versionNumber: 1, date: today }, versionData)]
      });
    }
    saveState();
    closeModal();
    showToast(`Recipe "${name}" saved.`, 'success');
    renderRecipes();
    renderHome();
    if (currentView === 'recipe-detail' && currentDetailRecipeId) renderRecipeDetail(currentDetailRecipeId);
  });
}

// ---------- Bake modal ----------
function populateBakeRecipeSelect() {
  const select = document.getElementById('bake-recipe');
  if (state.recipes.length === 0) {
    select.innerHTML = '<option value="">No recipes yet</option>';
    return;
  }
  select.innerHTML = state.recipes.map(r =>
    `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.category)})</option>`
  ).join('');
}
function updateBakeCostPreview() {
  const recipeId = document.getElementById('bake-recipe').value;
  const batches = parseFloat(document.getElementById('bake-batches').value) || 0;
  const preview = document.getElementById('bake-cost-preview');
  const recipe = findRecipeById(recipeId);
  if (!recipe) {
    preview.innerHTML = '';
    return;
  }
  const v = currentVersion(recipe);
  const totalCost = computeRecipeCost(v) * batches;
  const totalYield = v.yieldQty * batches;
  const costPerItem = totalYield > 0 ? totalCost / totalYield : 0;
  const linesHtml = v.lines.map(line => {
    const ing = findIngredient(line.ingredientName);
    const needed = line.qtyCanonical * batches;
    const { source } = getLineCostInfo(line);
    let warn = '';
    if (ing && ing.onHandQty - needed < 0) warn = ' <span class="warn">— will go negative</span>';
    const sourceNote = source !== 'inventory' ? ` <span class="muted">(${COST_SOURCE_LABELS[source]})</span>` : '';
    return `<div>${escapeHtml(line.ingredientName)}: ${formatQty(line.category, needed)}${sourceNote}${warn}</div>`;
  }).join('');
  preview.innerHTML =
    `<div class="big">Total Cost: ${formatMoney(totalCost)} • ${formatMoney(costPerItem)}/${escapeHtml(v.yieldLabel)}</div>${linesHtml}`;
}
function openBakeModal() {
  document.getElementById('form-bake').reset();
  populateBakeRecipeSelect();
  document.getElementById('bake-batches').value = 1;
  updateBakeCostPreview();
  openModal('modal-bake');
}
function wireBakeModal() {
  document.getElementById('bake-recipe').addEventListener('change', updateBakeCostPreview);
  document.getElementById('bake-batches').addEventListener('input', updateBakeCostPreview);
  document.getElementById('form-bake').addEventListener('submit', e => {
    e.preventDefault();
    const recipeId = document.getElementById('bake-recipe').value;
    const batches = parseFloat(document.getElementById('bake-batches').value) || 0;
    const howItWent = document.getElementById('bake-how').value.trim();
    const whatToChange = document.getElementById('bake-change').value.trim();
    const recipe = findRecipeById(recipeId);
    if (!recipe || batches <= 0) {
      showToast('Pick a recipe and a batch count.', 'error');
      return;
    }
    const v = currentVersion(recipe);
    v.lines.forEach(line => {
      const ing = findIngredient(line.ingredientName);
      if (ing) ing.onHandQty -= line.qtyCanonical * batches;
    });
    const totalCost = computeRecipeCost(v) * batches;
    const totalYield = v.yieldQty * batches;
    const costPerItem = totalYield > 0 ? totalCost / totalYield : 0;
    state.bakeLog.push({
      id: uid(), createdAt: Date.now(), date: todayISO(), recipeId: recipe.id,
      recipeSnapshot: {
        name: recipe.name, category: recipe.category, versionNumber: v.versionNumber,
        yieldQty: v.yieldQty, yieldLabel: v.yieldLabel, lines: JSON.parse(JSON.stringify(v.lines)),
        prepMinutes: v.prepMinutes, bakeMinutes: v.bakeMinutes,
        ovenTemp: v.ovenTemp, ovenTempUnit: v.ovenTempUnit,
        steps: (v.steps || []).slice()
      },
      batches, totalCost, costPerItem, howItWent, whatToChange
    });
    saveState();
    closeModal();
    showToast(`Logged bake: ${recipe.name}`, 'success');
    renderBakeLog();
    renderInventory();
    renderHome();
    if (currentView === 'recipe-detail' && currentDetailRecipeId) renderRecipeDetail(currentDetailRecipeId);
  });
}

// ---------- Rendering: Home ----------
function summaryCard(value, label, icon) {
  return `<div class="summary-card">${icon ? `<span class="icon">${icon}</span>` : ''}<div class="value">${value}</div><div class="label">${label}</div></div>`;
}
function renderHome() {
  const totalInventoryValue = state.ingredients.reduce((sum, i) => sum + i.onHandQty * i.unitCost, 0);
  const monthPrefix = todayISO().slice(0, 7);
  const spentThisMonth = state.purchases
    .filter(p => p.date.startsWith(monthPrefix))
    .reduce((s, p) => s + p.price, 0);

  document.getElementById('summary-cards').innerHTML =
    summaryCard(formatMoney(totalInventoryValue), 'Inventory Value', '💰') +
    summaryCard(state.recipes.length, 'Recipes', '📖') +
    summaryCard(formatMoney(spentThisMonth), 'Spent This Month', '🧾');

  const activity = [
    ...state.purchases.map(p => ({ date: p.date, html: `🧾 Bought ${p.qty} ${escapeHtml(p.unit)} ${escapeHtml(p.ingredientName)} — ${formatMoney(p.price)}` })),
    ...state.bakeLog.map(b => ({ date: b.date, html: `🥐 Baked ${escapeHtml(b.recipeSnapshot.name)} (${b.batches} batch) — ${formatMoney(b.totalCost)}` }))
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  document.getElementById('recent-activity').innerHTML = activity.length
    ? activity.map(a => `<div class="activity-item"><span>${a.html}</span><span class="muted">${a.date}</span></div>`).join('')
    : '<p class="empty-state">No activity yet.</p>';
}

// ---------- Rendering: Inventory ----------
function renderInventorySummary() {
  const totalValue = state.ingredients.reduce((sum, i) => sum + i.onHandQty * i.unitCost, 0);
  document.getElementById('inventory-summary').innerHTML =
    summaryCard(formatMoney(totalValue), 'Total Inventory Value', '💰') +
    summaryCard(state.ingredients.length, 'Ingredients Tracked', '🧺');
}
function renderInventory() {
  const tbody = document.querySelector('#inventory-table tbody');
  const table = document.getElementById('inventory-table');
  const empty = document.getElementById('inventory-empty');
  if (state.ingredients.length === 0) {
    table.classList.add('hidden');
    empty.classList.remove('hidden');
    tbody.innerHTML = '';
  } else {
    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = state.ingredients.map(ing => {
      const value = ing.onHandQty * ing.unitCost;
      const rowClass = ing.onHandQty < 0 ? 'negative' : '';
      if (inventoryEditingId === ing.id) {
        return `<tr class="${rowClass}" data-id="${ing.id}">
          <td>${escapeHtml(ing.name)}</td>
          <td>${capitalize(ing.category)}</td>
          <td class="num-col"><input type="number" step="any" class="edit-onhand" value="${round2(ing.onHandQty)}"> ${canonicalUnitLabel(ing.category)}</td>
          <td class="num-col"><input type="number" step="any" class="edit-unitcost" value="${ing.unitCost}"></td>
          <td class="num-col">${formatMoney(value)}</td>
          <td><button class="btn btn-primary btn-small inv-save">Save</button> <button class="btn btn-ghost btn-small inv-cancel">Cancel</button></td>
        </tr>`;
      }
      return `<tr class="${rowClass}" data-id="${ing.id}">
        <td>${escapeHtml(ing.name)}</td>
        <td>${capitalize(ing.category)}</td>
        <td class="num-col">${formatQty(ing.category, ing.onHandQty)}</td>
        <td class="num-col">${formatUnitCost(ing.unitCost)}/${canonicalUnitLabel(ing.category)}</td>
        <td class="num-col">${formatMoney(value)}</td>
        <td><button class="btn btn-ghost btn-small inv-edit">Edit</button> <button class="btn btn-danger btn-small inv-delete">Delete</button></td>
      </tr>`;
    }).join('');
  }
  renderInventorySummary();
  updateIngredientDatalist();
}
async function deleteIngredient(id) {
  const ing = findIngredientById(id);
  if (!ing) return;
  const usedIn = state.recipes.filter(r =>
    currentVersion(r).lines.some(l => l.ingredientName.toLowerCase() === ing.name.toLowerCase())
  );
  let msg = `Delete "${ing.name}" from inventory?`;
  if (usedIn.length) msg += ` It's used in ${usedIn.length} recipe(s) — their cost will fall back to any backup cost you've entered, or $0 if none.`;
  const ok = await confirmDialog(msg, 'Delete ingredient?');
  if (!ok) return;
  state.ingredients = state.ingredients.filter(i => i.id !== id);
  // A tombstone means this deletion sticks even if a later merge brings in a backup
  // from a device that still has this ingredient.
  state.tombstones.push({ id: uid(), type: 'ingredient', targetId: id, deletedAt: Date.now() });
  saveState();
  renderInventory();
  renderHome();
  showToast('Ingredient deleted.', 'success');
}
function wireInventoryTable() {
  document.querySelector('#inventory-table tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.classList.contains('inv-edit')) {
      inventoryEditingId = id;
      renderInventory();
    } else if (e.target.classList.contains('inv-cancel')) {
      inventoryEditingId = null;
      renderInventory();
    } else if (e.target.classList.contains('inv-delete')) {
      deleteIngredient(id);
    } else if (e.target.classList.contains('inv-save')) {
      const ing = findIngredientById(id);
      const onHand = parseFloat(tr.querySelector('.edit-onhand').value);
      const unitCost = parseFloat(tr.querySelector('.edit-unitcost').value);
      const adjustment = { id: uid(), createdAt: Date.now(), date: todayISO(), ingredientName: ing.name };
      if (!isNaN(onHand)) { ing.onHandQty = onHand; adjustment.onHandQty = onHand; }
      if (!isNaN(unitCost)) { ing.unitCost = unitCost; adjustment.unitCost = unitCost; }
      // Logged as its own event (like a purchase) so this correction survives a merge
      // with another device instead of being silently overwritten by recomputed totals.
      state.adjustments.push(adjustment);
      inventoryEditingId = null;
      saveState();
      renderInventory();
      renderHome();
    }
  });
}

// ---------- Rendering: Recipes list ----------
function renderRecipes() {
  const container = document.getElementById('recipes-groups');
  const empty = document.getElementById('recipes-empty');
  if (state.recipes.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const groups = {};
  state.recipes.forEach(r => {
    const cat = r.category || 'Other';
    (groups[cat] = groups[cat] || []).push(r);
  });
  container.innerHTML = Object.keys(groups).sort().map(cat => {
    const color = categoryColor(cat);
    const suit = categorySuit(cat);
    const cards = groups[cat].map(r => {
      const v = currentVersion(r);
      const totalCost = computeRecipeCost(v);
      const costPerItem = v.yieldQty > 0 ? totalCost / v.yieldQty : 0;
      const badges = [];
      if (v.prepMinutes != null || v.bakeMinutes != null) {
        badges.push(`<span class="meta-badge">⏱️ ${(v.prepMinutes || 0) + (v.bakeMinutes || 0)} min</span>`);
      }
      if (v.ovenTemp != null) badges.push(`<span class="meta-badge">🌡️ ${v.ovenTemp}°${v.ovenTempUnit || 'F'}</span>`);
      return `<div class="recipe-card" data-id="${r.id}" style="--cat-color:${color}">
        <h3><span class="card-suit">${suit}</span>${escapeHtml(r.name)} <span class="version-badge">v${v.versionNumber}</span></h3>
        <div class="muted">Yield: ${v.yieldQty} ${escapeHtml(v.yieldLabel)}</div>
        ${badges.length ? `<div class="recipe-meta-row">${badges.join('')}</div>` : ''}
        <div class="cost-line">${formatMoney(costPerItem)} / item</div>
        <div class="muted">Total: ${formatMoney(totalCost)}</div>
      </div>`;
    }).join('');
    return `<div class="recipe-category-group" style="--cat-color:${color}"><h2><span class="card-suit">${suit}</span> ${escapeHtml(cat)}</h2><div class="recipe-cards">${cards}</div></div>`;
  }).join('');
  container.querySelectorAll('.recipe-card').forEach(card => {
    card.addEventListener('click', () => {
      showView('recipe-detail');
      renderRecipeDetail(card.dataset.id);
    });
  });
}

// ---------- Rendering: Recipe detail ----------
function renderRecipeDetail(recipeId) {
  currentDetailRecipeId = recipeId;
  const recipe = findRecipeById(recipeId);
  if (!recipe) {
    showView('recipes');
    return;
  }
  const v = currentVersion(recipe);
  document.getElementById('rd-title').innerHTML =
    `${categoryEmoji(recipe.category)} ${escapeHtml(recipe.name)} <span class="version-badge">v${v.versionNumber}</span>`;

  const totalCost = computeRecipeCost(v);
  const costPerItem = v.yieldQty > 0 ? totalCost / v.yieldQty : 0;
  const linesHtml = v.lines.map(line => {
    const { cost, source } = getLineCostInfo(line);
    return `<tr><td>${escapeHtml(line.ingredientName)}</td><td>${line.qty} ${escapeHtml(line.unit)}</td><td class="num-col">${formatMoney(cost)} <span class="muted">(${COST_SOURCE_LABELS[source]})</span></td></tr>`;
  }).join('');

  const metaBadges = [];
  if (v.prepMinutes != null) metaBadges.push(`<span class="meta-badge">⏱️ Prep ${v.prepMinutes} min</span>`);
  if (v.bakeMinutes != null) metaBadges.push(`<span class="meta-badge">🔥 Bake ${v.bakeMinutes} min</span>`);
  if (v.ovenTemp != null) metaBadges.push(`<span class="meta-badge">🌡️ ${v.ovenTemp}°${v.ovenTempUnit || 'F'}</span>`);
  metaBadges.push(`<span class="meta-badge">🍽️ ${v.yieldQty} ${escapeHtml(v.yieldLabel)}</span>`);

  const stepsHtml = (v.steps && v.steps.length)
    ? `<ul class="step-checklist" id="rd-steps">${v.steps.map((step, i) =>
        `<li data-step="${i}"><span class="step-badge">${i + 1}</span><span class="step-text">${escapeHtml(step)}</span></li>`
      ).join('')}</ul>`
    : '<p class="empty-state">No steps written yet — click Edit Recipe to add some.</p>';

  document.getElementById('rd-tab-current').innerHTML = `
    <div class="view-header">
      <div class="muted">${escapeHtml(recipe.category)}</div>
      <div>
        <button class="btn btn-ghost btn-small" id="rd-edit">✏️ Edit Recipe</button>
        <button class="btn btn-danger btn-small" id="rd-delete">🗑 Delete Recipe</button>
      </div>
    </div>
    <div class="recipe-meta-bar">${metaBadges.join('')}</div>
    <h3>Ingredients</h3>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Ingredient</th><th>Qty</th><th class="num-col">Cost</th></tr></thead><tbody>${linesHtml}</tbody></table></div>
    <div class="cost-preview"><span class="big">Total: ${formatMoney(totalCost)}</span> • ${formatMoney(costPerItem)} / ${escapeHtml(v.yieldLabel)}</div>
    <h3>Steps</h3>
    ${stepsHtml}
    ${v.notes ? `<h3>Notes</h3><p>${escapeHtml(v.notes)}</p>` : ''}
  `;
  document.getElementById('rd-edit').addEventListener('click', () => openRecipeModal(recipe.id));
  document.getElementById('rd-delete').addEventListener('click', async () => {
    const ok = await confirmDialog(`Delete "${recipe.name}"? This cannot be undone. Its bake history will be kept.`, 'Delete recipe?');
    if (ok) {
      state.recipes = state.recipes.filter(r => r.id !== recipe.id);
      state.tombstones.push({ id: uid(), type: 'recipe', targetId: recipe.id, deletedAt: Date.now() });
      saveState();
      renderRecipes();
      renderHome();
      showView('recipes');
      setActiveNav('recipes');
      showToast('Recipe deleted.', 'success');
    }
  });
  if (v.steps && v.steps.length) {
    document.querySelectorAll('#rd-steps li').forEach(li => {
      li.addEventListener('click', () => li.classList.toggle('done'));
    });
  }

  const history = state.bakeLog.filter(b => b.recipeId === recipeId).sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById('rd-tab-history').innerHTML = history.length
    ? history.map(b => `
      <div class="history-entry">
        <div class="history-meta"><span>${b.date} — v${b.recipeSnapshot.versionNumber} — ${b.batches} batch(es)</span><span>${formatMoney(b.totalCost)} (${formatMoney(b.costPerItem)}/item)</span></div>
        ${b.howItWent ? `<div class="note-label">How it went:</div><div>${escapeHtml(b.howItWent)}</div>` : ''}
        ${b.whatToChange ? `<div class="note-label">What to change:</div><div>${escapeHtml(b.whatToChange)}</div>` : ''}
      </div>
    `).join('')
    : '<p class="empty-state">No bakes logged for this recipe yet.</p>';
}

// ---------- Rendering: Bake Log ----------
function renderBakeLogSummary(entries) {
  const totalCost = entries.reduce((s, b) => s + b.totalCost, 0);
  const monthPrefix = todayISO().slice(0, 7);
  const thisMonth = entries.filter(b => b.date.startsWith(monthPrefix)).reduce((s, b) => s + b.totalCost, 0);
  document.getElementById('bakelog-summary').innerHTML =
    summaryCard(entries.length, 'Bakes Logged', '🥄') +
    summaryCard(formatMoney(totalCost), 'Total Cost (All Time)', '💸') +
    summaryCard(formatMoney(thisMonth), 'Cost This Month', '📅');
}
function renderBakeLog() {
  const tbody = document.querySelector('#bakelog-table tbody');
  const table = document.getElementById('bakelog-table');
  const empty = document.getElementById('bakelog-empty');
  const entries = [...state.bakeLog].sort((a, b) => b.date.localeCompare(a.date));
  if (entries.length === 0) {
    table.classList.add('hidden');
    empty.classList.remove('hidden');
    tbody.innerHTML = '';
  } else {
    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = entries.map(b => {
      const notes = [b.howItWent && `Went: ${b.howItWent}`, b.whatToChange && `Change: ${b.whatToChange}`].filter(Boolean).join(' | ');
      return `<tr>
        <td>${b.date}</td>
        <td>${escapeHtml(b.recipeSnapshot.name)} <span class="muted">v${b.recipeSnapshot.versionNumber}</span></td>
        <td>${escapeHtml(b.recipeSnapshot.category)}</td>
        <td class="num-col">${b.batches}</td>
        <td class="num-col">${formatMoney(b.totalCost)}</td>
        <td class="num-col">${formatMoney(b.costPerItem)}</td>
        <td title="${escapeHtml(notes)}">${escapeHtml(notes.slice(0, 40))}${notes.length > 40 ? '…' : ''}</td>
      </tr>`;
    }).join('');
  }
  renderBakeLogSummary(entries);
}

// ---------- Merge engine ----------
// Combines this device's data with an imported backup without ever losing or
// duplicating anything, so two devices can be synced by hand (e.g. via a shared
// Drive folder) without one device's edits silently clobbering the other's.
function unionById(a, b) {
  const map = new Map();
  (a || []).forEach(item => map.set(item.id, item));
  (b || []).forEach(item => map.set(item.id, item));
  return Array.from(map.values());
}
function eventTime(e) {
  return e.createdAt || (e.date ? new Date(e.date).getTime() : 0) || 0;
}
// Ingredient on-hand quantity and cost are never merged directly — they're rebuilt
// from the full combined purchase/adjustment/bake history, which is always correct
// regardless of which device recorded what.
function recomputeIngredientsFromHistory(purchases, adjustments, bakeLog, priorIngredients) {
  const events = [];
  purchases.forEach(p => events.push({ time: eventTime(p), type: 'purchase', ingredientName: p.ingredientName, qty: p.qty, unit: p.unit, price: p.price }));
  adjustments.forEach(a => events.push({ time: eventTime(a), type: 'adjustment', ingredientName: a.ingredientName, onHandQty: a.onHandQty, unitCost: a.unitCost }));
  bakeLog.forEach(b => {
    (b.recipeSnapshot.lines || []).forEach(line => {
      events.push({ time: eventTime(b), type: 'consume', ingredientName: line.ingredientName, qtyCanonical: line.qtyCanonical * b.batches });
    });
  });
  events.sort((a, b) => a.time - b.time);

  const existingIdByName = {};
  (priorIngredients || []).forEach(ing => {
    const key = ing.name.toLowerCase();
    if (!existingIdByName[key]) existingIdByName[key] = ing.id;
  });

  const byName = {};
  events.forEach(e => {
    const key = e.ingredientName.toLowerCase();
    if (e.type === 'consume') {
      if (byName[key]) byName[key].onHandQty -= e.qtyCanonical;
      return; // never deduct for an ingredient that was never purchased or adjusted
    }
    if (!byName[key]) {
      byName[key] = {
        id: existingIdByName[key] || uid(),
        name: e.ingredientName,
        category: e.type === 'purchase' ? inferCategoryFromUnit(e.unit) : 'weight',
        onHandQty: 0,
        unitCost: 0,
        lastPurchaseDate: null
      };
    }
    const ing = byName[key];
    if (e.type === 'purchase') {
      const qtyCanonical = toCanonical(ing.category, e.unit, e.qty);
      const newOnHand = ing.onHandQty + qtyCanonical;
      const costPerCanonical = qtyCanonical > 0 ? e.price / qtyCanonical : 0;
      ing.unitCost = newOnHand !== 0
        ? (ing.onHandQty * ing.unitCost + qtyCanonical * costPerCanonical) / newOnHand
        : costPerCanonical;
      ing.onHandQty = newOnHand;
    } else if (e.type === 'adjustment') {
      if (e.onHandQty != null) ing.onHandQty = e.onHandQty;
      if (e.unitCost != null) ing.unitCost = e.unitCost;
    }
  });
  return Object.values(byName);
}
// Recipe versions are unioned by their own permanent id, so if the same recipe was
// edited differently on two devices before syncing, both edits survive as separate
// versions (renumbered in date order) instead of one overwriting the other.
function mergeRecipes(localRecipes, incomingRecipes) {
  const byId = new Map();
  [...localRecipes, ...incomingRecipes].forEach(r => {
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id, name: r.name, category: r.category, versions: [] });
    const target = byId.get(r.id);
    const versionMap = new Map();
    target.versions.forEach(v => versionMap.set(v.id, v));
    (r.versions || []).forEach(v => versionMap.set(v.id || uid(), v));
    target.versions = Array.from(versionMap.values()).sort((a, b) => eventTime(a) - eventTime(b));
    target.versions.forEach((v, i) => { v.versionNumber = i + 1; });
    const latest = target.versions[target.versions.length - 1];
    target.name = latest.name || target.name;
    target.category = latest.category || target.category;
  });
  return Array.from(byId.values());
}
function mergeState(local, incoming) {
  const purchases = unionById(local.purchases, incoming.purchases);
  const adjustments = unionById(local.adjustments, incoming.adjustments);
  const bakeLog = unionById(local.bakeLog, incoming.bakeLog);
  const tombstones = unionById(local.tombstones, incoming.tombstones);
  let recipes = mergeRecipes(local.recipes || [], incoming.recipes || []);
  let ingredients = recomputeIngredientsFromHistory(purchases, adjustments, bakeLog, [...(local.ingredients || []), ...(incoming.ingredients || [])]);

  const deletedRecipeIds = new Set(tombstones.filter(t => t.type === 'recipe').map(t => t.targetId));
  const deletedIngredientIds = new Set(tombstones.filter(t => t.type === 'ingredient').map(t => t.targetId));
  recipes = recipes.filter(r => !deletedRecipeIds.has(r.id));
  ingredients = ingredients.filter(i => !deletedIngredientIds.has(i.id));

  return { ingredients, recipes, bakeLog, purchases, adjustments, tombstones };
}

// ---------- Export / Import ----------
function wireBackup() {
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nastia-bakery-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exported.', 'success');
  });
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.recipes) || !Array.isArray(parsed.bakeLog)) {
          showToast("That file doesn't look like a valid backup.", 'error');
          return;
        }
        const choice = await confirmDialog(
          "Merge this backup into what's already here? Anything new (purchases, recipes, bakes) gets added — nothing currently on this device is lost.",
          'Import backup',
          'Merge',
          'Replace everything instead'
        );
        if (choice === false) return;
        if (choice === 'alt') {
          const reallyReplace = await confirmDialog(
            'This throws away everything currently on this device and replaces it with exactly what’s in the backup file. This cannot be undone.',
            'Replace all data?',
            'Replace Everything'
          );
          if (!reallyReplace) return;
          state = Object.assign({}, getDefaultState(), parsed);
          saveState();
          renderAll();
          showToast('Data replaced from backup.', 'success');
          return;
        }
        const countVersions = s => s.recipes.reduce((sum, r) => sum + r.versions.length, 0);
        const before = {
          p: state.purchases.length, r: state.recipes.length, b: state.bakeLog.length,
          a: state.adjustments.length, v: countVersions(state)
        };
        state = mergeState(state, Object.assign({}, getDefaultState(), parsed));
        saveState();
        renderAll();
        const added = {
          p: state.purchases.length - before.p,
          r: state.recipes.length - before.r,
          b: state.bakeLog.length - before.b,
          a: state.adjustments.length - before.a,
          v: countVersions(state) - before.v
        };
        const parts = [];
        if (added.p > 0) parts.push(`${added.p} purchase${added.p === 1 ? '' : 's'}`);
        if (added.r > 0) parts.push(`${added.r} new recipe${added.r === 1 ? '' : 's'}`);
        else if (added.v > 0) parts.push(`${added.v} recipe update${added.v === 1 ? '' : 's'}`);
        if (added.b > 0) parts.push(`${added.b} bake${added.b === 1 ? '' : 's'}`);
        if (added.a > 0) parts.push(`${added.a} inventory correction${added.a === 1 ? '' : 's'}`);
        showToast(parts.length ? `Merged: added ${parts.join(', ')}.` : 'Merged — nothing new to add.', 'success');
      } catch (err) {
        showToast('Could not read that file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
}

// ---------- Render everything ----------
function renderAll() {
  renderHome();
  renderInventory();
  renderRecipes();
  renderBakeLog();
}

// ---------- Init ----------
function wireNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      setActiveNav(section);
      showView(section);
      if (section === 'home') renderHome();
      if (section === 'inventory') renderInventory();
      if (section === 'recipes') renderRecipes();
      if (section === 'bakelog') renderBakeLog();
      closeMobileMenu();
    });
  });
  document.getElementById('rd-back').addEventListener('click', () => {
    showView('recipes');
    setActiveNav('recipes');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('rd-tab-current').classList.toggle('hidden', btn.dataset.tab !== 'current');
      document.getElementById('rd-tab-history').classList.toggle('hidden', btn.dataset.tab !== 'history');
    });
  });
}
// ---------- Mobile drawer menu ----------
function closeMobileMenu() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
}
function wireMobileMenu() {
  document.getElementById('menu-toggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const isOpen = sidebar.classList.toggle('open');
    document.getElementById('sidebar-backdrop').classList.toggle('hidden', !isOpen);
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileMenu);
}
function goToSectionAnd(section, renderFn, openFn) {
  setActiveNav(section);
  showView(section);
  renderFn();
  openFn();
}
function wireModals() {
  document.querySelectorAll('.modal-cancel').forEach(btn => btn.addEventListener('click', closeModal));
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') {
      closeModal();
      if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    }
  });
  // Home's quick actions jump to the section that owns that form first, then open
  // the same dialog its own button opens — so closing it leaves you on that page.
  document.getElementById('qa-invoice').addEventListener('click', () => goToSectionAnd('inventory', renderInventory, openInvoiceModal));
  document.getElementById('qa-recipe').addEventListener('click', () => goToSectionAnd('recipes', renderRecipes, () => openRecipeModal(null)));
  document.getElementById('qa-bake').addEventListener('click', () => goToSectionAnd('bakelog', renderBakeLog, openBakeModal));

  document.getElementById('inv-add-invoice').addEventListener('click', openInvoiceModal);
  document.getElementById('rec-add-recipe').addEventListener('click', () => openRecipeModal(null));
  document.getElementById('bl-add-bake').addEventListener('click', openBakeModal);

  document.getElementById('inventory-empty-cta').addEventListener('click', openInvoiceModal);
  document.getElementById('recipes-empty-cta').addEventListener('click', () => openRecipeModal(null));
  document.getElementById('bakelog-empty-cta').addEventListener('click', openBakeModal);
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  wireNavigation();
  wireMobileMenu();
  wireModals();
  wireConfirmModal();
  wireInvoiceModal();
  wireRecipeModal();
  wireBakeModal();
  wireInventoryTable();
  wireBackup();
  renderAll();
  showView('home');
  setActiveNav('home');
});
