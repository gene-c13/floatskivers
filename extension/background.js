const FAIRPRICE_CART_URL = "https://www.fairprice.com.sg/cart";

function waitForTabLoad(tabId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("FairPrice took too long to load.")));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve);
      }
    };

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    function finish(callback) {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    }

    chrome.tabs.onUpdated.addListener(listener);
    // Covers the small race where the document finished between creating the
    // tab and registering the event listener.
    chrome.tabs.get(tabId).then((currentTab) => {
      if (currentTab.status === "complete") finish(resolve);
    }).catch(() => finish(() => reject(new Error("FairPrice tab was closed."))));
  });
}

// This runs in a FairPrice page, so it deliberately uses the site's own
// localStorage rather than extension storage.  The fields mirror the cart
// entry created by FairPrice for a guest cart.  FairPrice rehydrates it when
// the cart page opens immediately afterwards.
function addProductsToFairPriceCart(items) {
  const cart = JSON.parse(localStorage.getItem("cart") || "{}");
  const results = [];

  for (const { product, quantity } of items) {
    const productId = String(product?.id ?? "");
    if (!productId) continue;

    const requestedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
    const existing = cart[productId];

    if (existing) {
      const nextQuantity = Math.max(0, Number(existing.q ?? existing.count ?? 0)) + requestedQuantity;
      existing.q = String(nextQuantity);
      existing.count = nextQuantity;
      existing.t = Math.floor(Date.now() / 1000);
    } else {
      const storeData = Array.isArray(product.storeSpecificData)
        ? product.storeSpecificData[0]
        : product.storeSpecificData;
      const price = Number(product.final_price ?? storeData?.mrp ?? product.mrp ?? 0);
      const discount = Number(storeData?.discount ?? 0);

      // Keep FairPrice's product object intact and also expose its fields at
      // the top level, as entries produced by the website do.
      cart[productId] = {
        ...product,
        id: product.id,
        q: String(requestedQuantity),
        wantQuantity: "0",
        reason: product.has_stock === false ? "OutOfStock" : "InStock",
        t: Math.floor(Date.now() / 1000),
        p: null,
        mrp: price,
        priceOverridden: false,
        discount,
        isFree: false,
        handlingDays: product.handlingDays ?? 0,
        deliveredBy: "",
        isMKP: false,
        product,
        offersUnApplied: product.offers ?? [],
        isChecked: true,
        isUserEditQuantity: false,
        bulkRoutingThreshold: storeData?.bulkRoutingThreshold ?? null,
        __server__handlingDays: product.handlingDays ?? 0,
        __serverIndex__: 0,
        count: requestedQuantity,
        totalDiscount: 0,
      };
    }

    results.push({ productId, quantity: Number(cart[productId].q) });
  }

  localStorage.setItem("cart", JSON.stringify(cart));
  return results;
}

async function addAndShowCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No matched FairPrice products were provided.");
  }

  // A real FairPrice document is needed because localStorage is scoped to
  // its origin. The product tab is immediately reused for the cart, so the
  // user sees the result rather than a transient background tab.
  const firstProduct = items[0].product;
  const tab = await chrome.tabs.create({
    active: false,
    url: `https://www.fairprice.com.sg/product/${firstProduct.slug}-${firstProduct.clientItemId}`,
  });

  try {
    await waitForTabLoad(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: addProductsToFairPriceCart,
      args: [items],
    });
    await chrome.tabs.update(tab.id, { active: true, url: FAIRPRICE_CART_URL });
    return result;
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ADD_FAIRPRICE_PRODUCTS") return;

  addAndShowCart(message.items)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
