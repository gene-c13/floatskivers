const BACKEND_URL = "https://floatskivers.onrender.com/shopping-list";
const PICK_PRODUCTS_URL = "https://floatskivers.onrender.com/pick-products";

const recipeListEl = document.getElementById("recipeList");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const addAllButton = document.getElementById("addAll");
const FAIRPRICE_ORIGIN = "https://www.fairprice.com.sg";
const FAIRPRICE_SEARCH_URL = `${FAIRPRICE_ORIGIN}/search?query=`;
let selectedMatches = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

async function getRecipes() {
  const { recipes = [] } = await chrome.storage.local.get("recipes");
  return recipes;
}

async function saveRecipes(recipes) {
  await chrome.storage.local.set({ recipes });
}

async function renderRecipeList() {
  const recipes = await getRecipes();
  clearChildren(recipeListEl);
  for (const recipe of recipes) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.textContent = recipe.url;
    span.title = recipe.url;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", async () => {
      const updated = (await getRecipes()).filter((r) => r.url !== recipe.url);
      await saveRecipes(updated);
      renderRecipeList();
    });

    li.appendChild(span);
    li.appendChild(removeBtn);
    recipeListEl.appendChild(li);
  }
}

document.getElementById("addPage").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    setStatus("Could not read the current tab's URL.");
    return;
  }
  if (!tab.url.includes("allrecipes.com")) {
    setStatus("This only works on allrecipes.com pages right now.");
    return;
  }

  const recipes = await getRecipes();
  if (recipes.some((r) => r.url === tab.url)) {
    setStatus("Already added.");
    return;
  }

  // Read the page's own HTML directly from the tab instead of having the
  // backend re-fetch it: AllRecipes' bot protection blocks scripted
  // server-side requests, but the page the user is already looking at
  // loaded here just fine.
  let html;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    html = result;
  } catch (err) {
    setStatus(`Could not read this page's content: ${err.message}`);
    return;
  }

  recipes.push({ url: tab.url, html });
  await saveRecipes(recipes);
  setStatus("");
  renderRecipeList();
});

function formatQuantity(item) {
  if (item.needs_manual_reconciliation) return "needs review";
  return `${item.quantity} ${item.unit ?? ""}`.trim();
}

function productPrice(product) {
  const storeData = Array.isArray(product.storeSpecificData)
    ? product.storeSpecificData[0]
    : product.storeSpecificData;
  const price = Number(product.final_price ?? storeData?.mrp ?? product.mrp);
  return Number.isFinite(price) ? `$${price.toFixed(2)}` : "Price unavailable";
}

function productPackSize(product) {
  return product.metaData?.DisplayUnit || product.metaData?.["Unit Of Weight"] || "";
}

function productUrl(product) {
  return `${FAIRPRICE_ORIGIN}/product/${product.slug}-${product.clientItemId}`;
}

function createIngredientRow(item) {
  const row = document.createElement("div");
  row.className = "item";

  const head = document.createElement("div");
  head.className = "item-head";

  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = item.name;

  const quantity = document.createElement("span");
  quantity.className = item.needs_manual_reconciliation ? "item-quantity flag" : "item-quantity";
  quantity.textContent = formatQuantity(item);

  const choice = document.createElement("span");
  choice.className = "searching";
  choice.textContent = "Asking the agent for the best FairPrice match…";

  head.appendChild(name);
  head.appendChild(quantity);
  row.appendChild(head);
  row.appendChild(choice);
  resultEl.appendChild(row);
  return choice;
}

function showSelectedProduct(choiceEl, item, pick, onIncludeChange) {
  clearChildren(choiceEl);
  const product = pick.product;

  if (!product) {
    choiceEl.className = "flag";
    if (pick.decided_by === "error") {
      choiceEl.textContent = `Could not get a pick: ${pick.reason}`;
    } else if (pick.is_substitute) {
      choiceEl.textContent = `No reasonable substitute found — ${pick.reason || "original out of stock"}`;
    } else if (pick.decided_by === "search") {
      choiceEl.textContent = pick.reason || "No FairPrice match found";
    } else {
      choiceEl.textContent = pick.reason ? `Skipped — ${pick.reason}` : "No in-stock FairPrice match found";
    }
    return;
  }

  choiceEl.className = pick.is_substitute ? "substitute" : "";

  if (pick.is_substitute) {
    const badge = document.createElement("div");
    badge.className = "substitute-badge";
    badge.textContent = `"${item.name}" is out of stock — agent suggests this substitute:`;
    choiceEl.appendChild(badge);
  }

  const link = document.createElement("a");
  link.className = "chosen-product";
  link.href = productUrl(product);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = product.name;

  const meta = document.createElement("span");
  meta.className = "chosen-meta";
  const packLabel = pick.quantity === 1 ? "1 pack" : `${pick.quantity} packs`;
  meta.textContent = [productPackSize(product), productPrice(product), packLabel]
    .filter(Boolean)
    .join(" · ");

  choiceEl.appendChild(link);
  choiceEl.appendChild(meta);

  if (pick.is_substitute) {
    if (pick.reason) {
      const reason = document.createElement("span");
      reason.className = "chosen-meta";
      reason.textContent = pick.reason;
      choiceEl.appendChild(reason);
    }

    const optIn = document.createElement("label");
    optIn.className = "substitute-opt-in";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => onIncludeChange(checkbox.checked));
    optIn.appendChild(checkbox);
    optIn.appendChild(document.createTextNode(" Add this substitute to the cart"));
    choiceEl.appendChild(optIn);
  }

  const searchLink = document.createElement("a");
  searchLink.className = "chosen-meta";
  searchLink.href = `${FAIRPRICE_SEARCH_URL}${encodeURIComponent(item.name)}`;
  searchLink.target = "_blank";
  searchLink.rel = "noreferrer";
  searchLink.textContent = "See all search results";
  choiceEl.appendChild(searchLink);
}

async function renderResult(data) {
  clearChildren(resultEl);
  selectedMatches = [];
  addAllButton.hidden = false;
  addAllButton.disabled = true;
  addAllButton.textContent = "Asking the agent to pick products…";

  for (const err of data.errors || []) {
    const div = document.createElement("div");
    div.className = "flag";
    div.textContent = `Failed: ${err.url} (${err.error})`;
    resultEl.appendChild(div);
  }

  const items = data.shopping_list || [];
  const rowsByName = new Map(items.map((item) => [item.name, createIngredientRow(item)]));

  // One request covers the whole list: the agent decides every item's pick
  // server-side (it needs to reach FairPrice and Bedrock, which this popup
  // can't do directly), so there's no per-row progress to stream here —
  // just a single wait, then all rows update at once.
  let picks;
  try {
    const response = await fetch(PICK_PRODUCTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopping_list: items }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `backend returned ${response.status}`);
    }
    ({ picks } = await response.json());
  } catch (error) {
    for (const choice of rowsByName.values()) {
      choice.className = "flag";
      choice.textContent = `Could not reach the picking agent: ${error.message}`;
    }
    setStatus(`Could not reach the picking agent: ${error.message}`);
    return;
  }

  // A normal match is included automatically; a substitute (the exact
  // ingredient was out of stock, so the agent suggested something else)
  // needs an explicit checkbox before it counts — see showSelectedProduct.
  const includedByName = new Map();

  function recomputeSelection() {
    selectedMatches = picks
      .filter((pick) => pick.product && (!pick.is_substitute || includedByName.get(pick.name)))
      .map((pick) => ({ product: pick.product, quantity: pick.quantity }));

    const missing = items.length - selectedMatches.length;
    addAllButton.disabled = selectedMatches.length === 0;
    addAllButton.textContent = `Add ${selectedMatches.length} ingredients to FairPrice Cart`;
    setStatus(
      missing
        ? `${selectedMatches.length} ready to add; ${missing} ingredient${missing === 1 ? "" : "s"} need review.`
        : `Found FairPrice matches for all ${selectedMatches.length} ingredients.`,
    );
  }

  for (const pick of picks) {
    const choice = rowsByName.get(pick.name);
    if (!choice) continue;
    showSelectedProduct(choice, { name: pick.name }, pick, (checked) => {
      includedByName.set(pick.name, checked);
      recomputeSelection();
    });
  }

  recomputeSelection();
}

addAllButton.addEventListener("click", async () => {
  if (selectedMatches.length === 0) return;

  addAllButton.disabled = true;
  addAllButton.textContent = "Adding to FairPrice Cart…";
  setStatus(`Adding ${selectedMatches.length} ingredients…`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ADD_FAIRPRICE_PRODUCTS",
      items: selectedMatches.map(({ product, quantity }) => ({ product, quantity })),
    });
    if (!response?.ok) throw new Error(response?.error || "FairPrice could not add the ingredients.");
    addAllButton.textContent = "Added to FairPrice Cart";
    setStatus(`Added ${response.result.length} ingredients. FairPrice cart opened.`);
  } catch (error) {
    addAllButton.disabled = false;
    addAllButton.textContent = `Add ${selectedMatches.length} ingredients to FairPrice Cart`;
    setStatus(`Could not add ingredients: ${error.message}`);
  }
});

document.getElementById("buildList").addEventListener("click", async () => {
  const recipes = await getRecipes();
  if (recipes.length === 0) {
    setStatus("Add at least one recipe first.");
    return;
  }

  setStatus("Building shopping list...");
  clearChildren(resultEl);
  selectedMatches = [];
  addAllButton.hidden = true;
  addAllButton.disabled = true;

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipes }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setStatus(`Backend error: ${body.error || response.status}`);
      return;
    }
    const data = await response.json();
    setStatus(`Built ${data.shopping_list.length} items. Finding FairPrice matches…`);
    await renderResult(data);
  } catch (err) {
    setStatus(`Could not reach the backend at ${BACKEND_URL}. Is server.py running?`);
  }
});

renderRecipeList();
