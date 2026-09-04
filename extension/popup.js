const BACKEND_URL = "https://floatskivers.onrender.com/shopping-list";

const recipeListEl = document.getElementById("recipeList");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const addAllButton = document.getElementById("addAll");
const resultsPanelEl = document.getElementById("resultsPanel");
const recipeCountEl = document.getElementById("recipeCount");
const matchCountEl = document.getElementById("matchCount");
const cartProgressEl = document.getElementById("cartProgress");
const progressCountEl = document.getElementById("progressCount");
const progressProductEl = document.getElementById("progressProduct");
const progressBarEl = document.getElementById("progressBar");
const progressStageEl = document.getElementById("progressStage");
const FAIRPRICE_ORIGIN = "https://www.fairprice.com.sg";
const FAIRPRICE_SEARCH_URL = `${FAIRPRICE_ORIGIN}/search?query=`;
const productSearchCache = new Map();
let selectedMatches = [];

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "FAIRPRICE_ADD_PROGRESS") return;
  updateCartProgress(message);
});

function updateCartProgress(message) {
  const total = Math.max(1, Number(message.total) || selectedMatches.length || 1);
  const current = Math.max(1, Number(message.current) || 1);
  const completed = message.stage === "complete" ? current : current - 1;
  const percentage = message.stage === "finished" ? 100 : Math.round((completed / total) * 100);
  const stageLabels = {
    opening: "Opening product page in the background…",
    native: "Waiting for FairPrice’s native Add to cart button…",
    fallback: "Native cart was slow — using the safe fallback…",
    complete: message.method === "native"
      ? "Added with FairPrice’s native cart"
      : message.method === "localStorage"
        ? "Added with the cart fallback"
        : "Could not add this product",
    finished: "Finished — opening your FairPrice cart…",
  };

  cartProgressEl.classList.add("visible");
  progressCountEl.textContent = message.stage === "finished" ? `${total} / ${total}` : `${current} / ${total}`;
  progressProductEl.textContent = message.productName || "All products processed";
  progressBarEl.style.width = `${percentage}%`;
  progressStageEl.textContent = stageLabels[message.stage] || "Working in the background…";

  const activeRow = Array.from(resultEl.querySelectorAll(".item"))
    .find((row) => row.dataset.queueIndex === String(current));
  if (activeRow) {
    activeRow.dataset.state = message.stage === "complete" ? message.method : "active";
    if (message.stage === "complete") {
      const meta = activeRow.querySelector(".chosen-meta");
      if (meta) {
        const method = message.method === "native" ? "Native cart ✓" : message.method === "localStorage" ? "Fallback ✓" : "Failed";
        meta.textContent = `${meta.dataset.baseText || meta.textContent} · ${method}`;
      }
    }
    activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

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
  recipeCountEl.textContent = String(recipes.length);
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

function searchableWords(text) {
  const ignored = new Set(["and", "of", "the", "a", "an", "fresh"]);
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignored.has(word));
}

function packAmountInGrams(displayUnit) {
  const text = String(displayUnit).toLowerCase().replace(/\s+/g, "");
  const multipack = text.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(kg|g)\b/);
  if (multipack) {
    const each = Number(multipack[2]) * (multipack[3] === "kg" ? 1000 : 1);
    return Number(multipack[1]) * each;
  }

  const singlePack = text.match(/(\d+(?:\.\d+)?)(kg|g)\b/);
  if (!singlePack) return null;
  return Number(singlePack[1]) * (singlePack[2] === "kg" ? 1000 : 1);
}

function recommendedPackCount(item, product) {
  if (item.needs_manual_reconciliation) return 1;

  if (item.unit === "g") {
    const packGrams = packAmountInGrams(productPackSize(product));
    if (packGrams && Number(item.quantity) > 0) {
      return Math.max(1, Math.ceil(Number(item.quantity) / packGrams));
    }
  }

  if (item.unit === "whole" && Number(item.quantity) > 0) {
    return Math.max(1, Math.ceil(Number(item.quantity)));
  }

  return 1;
}

function scoreProduct(item, product, index) {
  if (product.has_stock === false) return -Infinity;

  const query = searchableWords(item.name);
  const productText = searchableWords(`${product.name} ${product.metaData?.["SAP Product Name"] || ""}`);
  const productWords = new Set(productText);
  const matchingWords = query.filter((word) => productWords.has(word)).length;
  let score = matchingWords * 100 - Math.max(0, productText.length - query.length) * 0.5 - index;

  const normalizedName = product.name.toLowerCase();
  if (normalizedName.includes(item.name.toLowerCase())) score += 80;
  if (product.brand?.name?.toLowerCase() === "fairprice") score += 3;

  if (item.unit === "g" && Number(item.quantity) > 0) {
    const packGrams = packAmountInGrams(productPackSize(product));
    if (packGrams) {
      const packs = Math.ceil(Number(item.quantity) / packGrams);
      const excessRatio = ((packs * packGrams) - Number(item.quantity)) / Number(item.quantity);
      score += 30 - Math.min(25, excessRatio * 10);
    }
  }

  return score;
}

function chooseBestProduct(item, products) {
  return products
    .map((product, index) => ({ product, score: scoreProduct(item, product, index) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score)[0]?.product ?? null;
}

async function searchFairPrice(query) {
  if (!productSearchCache.has(query)) {
    productSearchCache.set(query, (async () => {
      const response = await fetch(`${FAIRPRICE_SEARCH_URL}${encodeURIComponent(query)}`, {
        // Preserve the shopper's selected store and delivery context when
        // FairPrice supplies location-specific stock and prices.
        credentials: "include",
      });
      if (!response.ok) throw new Error(`FairPrice search returned ${response.status}.`);

      const html = await response.text();
      const documentForSearch = new DOMParser().parseFromString(html, "text/html");
      const nextData = documentForSearch.getElementById("__NEXT_DATA__")?.textContent;
      if (!nextData) throw new Error("FairPrice did not return its search data.");

      const payload = JSON.parse(nextData);
      const layouts = payload.props?.pageProps?.data?.data?.page?.layouts ?? [];
      const collection = layouts.find((layout) => layout.name === "ProductCollection");
      return (collection?.value?.collection?.product ?? [])
        .filter((product) => product?.id && product?.name && product?.slug && product?.clientItemId);
    })());
  }
  return productSearchCache.get(query);
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
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
  choice.textContent = "Finding the best FairPrice match…";

  head.appendChild(name);
  head.appendChild(quantity);
  row.appendChild(head);
  row.appendChild(choice);
  resultEl.appendChild(row);
  return choice;
}

function showSelectedProduct(choiceEl, item, product, cartQuantity) {
  clearChildren(choiceEl);
  choiceEl.className = "";

  if (!product) {
    choiceEl.className = "flag";
    choiceEl.textContent = "No in-stock FairPrice match found";
    return;
  }

  const link = document.createElement("a");
  link.className = "chosen-product";
  link.href = productUrl(product);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = product.name;

  const meta = document.createElement("span");
  meta.className = "chosen-meta";
  const packLabel = cartQuantity === 1 ? "1 pack" : `${cartQuantity} packs`;
  meta.textContent = [productPackSize(product), productPrice(product), packLabel]
    .filter(Boolean)
    .join(" · ");
  meta.dataset.baseText = meta.textContent;

  const searchLink = document.createElement("a");
  searchLink.className = "chosen-meta";
  searchLink.href = `${FAIRPRICE_SEARCH_URL}${encodeURIComponent(item.name)}`;
  searchLink.target = "_blank";
  searchLink.rel = "noreferrer";
  searchLink.textContent = "See all search results";

  choiceEl.appendChild(link);
  choiceEl.appendChild(meta);
  choiceEl.appendChild(searchLink);
  choiceEl.closest(".item").dataset.productId = String(product.id);
}

async function renderResult(data) {
  clearChildren(resultEl);
  selectedMatches = [];
  resultsPanelEl.hidden = false;
  cartProgressEl.classList.remove("visible");
  progressBarEl.style.width = "0%";
  addAllButton.hidden = false;
  addAllButton.disabled = true;
  addAllButton.textContent = "Finding FairPrice matches…";

  for (const err of data.errors || []) {
    const div = document.createElement("div");
    div.className = "flag";
    div.textContent = `Failed: ${err.url} (${err.error})`;
    resultEl.appendChild(div);
  }

  const items = data.shopping_list || [];
  const rows = items.map((item) => ({ item, choice: createIngredientRow(item) }));
  let completed = 0;

  const matches = await mapWithConcurrency(rows, 3, async ({ item, choice }) => {
    try {
      const products = await searchFairPrice(item.name);
      const product = chooseBestProduct(item, products);
      const quantity = product ? recommendedPackCount(item, product) : 0;
      showSelectedProduct(choice, item, product, quantity);
      return product ? { item, product, quantity, row: choice.closest(".item") } : null;
    } catch (error) {
      choice.className = "flag";
      choice.textContent = `FairPrice search failed: ${error.message}`;
      return null;
    } finally {
      completed += 1;
      setStatus(`Matched ${completed} of ${items.length} ingredients…`);
    }
  });

  selectedMatches = matches.filter(Boolean);
  selectedMatches.forEach((match, index) => {
    match.row.dataset.queueIndex = String(index + 1);
  });
  const missing = items.length - selectedMatches.length;
  matchCountEl.textContent = `${selectedMatches.length}/${items.length}`;
  addAllButton.disabled = selectedMatches.length === 0;
  addAllButton.textContent = `Add ${selectedMatches.length} ingredients to FairPrice Cart`;
  setStatus(
    missing
      ? `Found ${selectedMatches.length} matches; ${missing} ingredient${missing === 1 ? "" : "s"} need review.`
      : `Found FairPrice matches for all ${selectedMatches.length} ingredients.`,
  );
}

addAllButton.addEventListener("click", async () => {
  if (selectedMatches.length === 0) return;

  addAllButton.disabled = true;
  addAllButton.textContent = "Adding to FairPrice Cart…";
  setStatus(`Adding ${selectedMatches.length} ingredients…`);
  cartProgressEl.classList.add("visible");
  progressCountEl.textContent = `0 / ${selectedMatches.length}`;
  progressProductEl.textContent = "Preparing the first product…";
  progressBarEl.style.width = "0%";
  progressStageEl.textContent = "Starting background cart worker…";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ADD_FAIRPRICE_PRODUCTS",
      items: selectedMatches.map(({ product, quantity }) => ({ product, quantity })),
    });
    if (!response?.ok) throw new Error(response?.error || "FairPrice could not add the ingredients.");
    const added = response.result.filter((item) => item.method !== "failed");
    const native = added.filter((item) => item.method === "native").length;
    const fallback = added.filter((item) => item.method === "localStorage").length;
    const failed = response.result.length - added.length;
    addAllButton.textContent = "Added to FairPrice Cart";
    progressBarEl.style.width = "100%";
    progressCountEl.textContent = `${response.result.length} / ${response.result.length}`;
    progressProductEl.textContent = "Cart ready";
    progressStageEl.textContent = "Finished — opening your FairPrice cart…";
    setStatus(
      `Added ${added.length} ingredients (${native} native, ${fallback} fallback)`
      + `${failed ? `; ${failed} failed` : ""}. FairPrice cart opened.`,
    );
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
  resultsPanelEl.hidden = true;
  cartProgressEl.classList.remove("visible");
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
