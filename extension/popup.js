const BACKEND_URL = "https://floatskivers.onrender.com/shopping-list";

const recipeListEl = document.getElementById("recipeList");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

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

function renderResult(data) {
  clearChildren(resultEl);

  for (const err of data.errors || []) {
    const div = document.createElement("div");
    div.className = "flag";
    div.textContent = `Failed: ${err.url} (${err.error})`;
    resultEl.appendChild(div);
  }

  for (const item of data.shopping_list || []) {
    const div = document.createElement("div");
    div.className = "item";

    const name = document.createElement("span");
    const qty = document.createElement("span");

    if (item.needs_manual_reconciliation) {
      name.textContent = item.name;
      qty.textContent = "needs review";
      qty.className = "flag";
    } else {
      name.textContent = item.name;
      qty.textContent = `${item.quantity} ${item.unit ?? ""}`.trim();
    }

    div.appendChild(name);
    div.appendChild(qty);
    resultEl.appendChild(div);
  }
}

document.getElementById("buildList").addEventListener("click", async () => {
  const recipes = await getRecipes();
  if (recipes.length === 0) {
    setStatus("Add at least one recipe first.");
    return;
  }

  setStatus("Building shopping list...");
  clearChildren(resultEl);

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
    setStatus(`${data.shopping_list.length} items across ${data.recipes.length} recipes.`);
    renderResult(data);
  } catch (err) {
    setStatus(`Could not reach the backend at ${BACKEND_URL}. Is server.py running?`);
  }
});

renderRecipeList();
