const FAIRPRICE_CART_URL = "https://www.fairprice.com.sg/cart";

function navigateTabAndWait(tabId, url, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("FairPrice took too long to load.")));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo, updatedTab) => {
      // Start working as soon as the new document commits. Waiting for
      // images, analytics, and recommendations to finish made every item
      // noticeably slower and none of those resources are needed here.
      if (updatedTabId === tabId && changeInfo.status === "loading" && updatedTab.url === url) {
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
    chrome.tabs.update(tabId, { url })
      .catch(() => finish(() => reject(new Error("FairPrice tab was closed."))));
  });
}

// Runs in a FairPrice product page. Native page events are used first, and
// guest-cart localStorage is observed only to confirm that FairPrice accepted
// each click. If more than one pack is requested, the native increment control
// is clicked for the remaining packs when available.
async function tryNativeAdd(productId, requestedQuantity, timeoutMs) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function cartQuantity() {
    try {
      const cart = JSON.parse(localStorage.getItem("cart") || "{}");
      const entry = cart[String(productId)];
      return Math.max(0, Number(entry?.q ?? entry?.count ?? 0) || 0);
    } catch (_error) {
      return 0;
    }
  }

  function findAddButton() {
    return document.querySelector('button[data-testid="SvgAddToCart"]')
      || Array.from(document.querySelectorAll("button")).find((button) => {
        const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
        return /add\s*to\s*cart/i.test(label);
      });
  }

  function findIncrementButton() {
    const selectors = [
      'button[data-testid*="increase" i]',
      'button[data-testid*="increment" i]',
      'button[aria-label*="increase" i]',
      'button[aria-label*="increment" i]',
      'button[title*="increase" i]',
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return Array.from(document.querySelectorAll("button")).find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
      return label === "+" || /increase\s*(item|quantity)/i.test(label);
    });
  }

  async function waitFor(getValue, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await sleep(250);
    }
    return null;
  }

  async function waitForQuantityAbove(previousQuantity, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const quantity = cartQuantity();
      if (quantity > previousQuantity) return quantity;
      await sleep(250);
    }
    return cartQuantity();
  }

  const before = cartQuantity();
  const target = before + Math.max(1, Math.floor(Number(requestedQuantity) || 1));
  const addButton = await waitFor(findAddButton, timeoutMs);
  if (!addButton || addButton.disabled) {
    return { before, after: cartQuantity(), target, verified: false, reason: "add button unavailable" };
  }

  addButton.click();
  let after = await waitForQuantityAbove(before, Math.min(timeoutMs, 2_500));
  if (after <= before) {
    return { before, after, target, verified: false, reason: "cart quantity did not change" };
  }

  while (after < target) {
    const incrementButton = await waitFor(findIncrementButton, 1_500);
    if (!incrementButton || incrementButton.disabled) break;
    const previous = after;
    incrementButton.click();
    after = await waitForQuantityAbove(previous, 2_500);
    if (after <= previous) break;
  }

  return {
    before,
    after,
    target,
    verified: after >= target,
    reason: after >= target ? null : "native quantity control did not reach the requested quantity",
  };
}

// Fallback for guest carts. This mirrors the cart entry produced by FairPrice,
// but writes an absolute target quantity so a partially successful native add
// is never counted twice.
function setFairPriceCartQuantity(product, targetQuantity) {
  const cart = JSON.parse(localStorage.getItem("cart") || "{}");
  const productId = String(product?.id ?? "");
  if (!productId) throw new Error("The selected FairPrice product has no product ID.");

  const quantity = Math.max(1, Math.floor(Number(targetQuantity) || 1));
  const existing = cart[productId];

  if (existing) {
    existing.q = String(quantity);
    existing.count = quantity;
    existing.t = Math.floor(Date.now() / 1000);
  } else {
    const storeData = Array.isArray(product.storeSpecificData)
      ? product.storeSpecificData[0]
      : product.storeSpecificData;
    const price = Number(product.final_price ?? storeData?.mrp ?? product.mrp ?? 0);
    const discount = Number(storeData?.discount ?? 0);

    cart[productId] = {
      ...product,
      id: product.id,
      q: String(quantity),
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
      count: quantity,
      totalDiscount: 0,
    };
  }

  localStorage.setItem("cart", JSON.stringify(cart));
  const saved = JSON.parse(localStorage.getItem("cart") || "{}")[productId];
  return { productId, quantity: Number(saved?.q ?? saved?.count ?? 0) };
}

function readFairPriceCartQuantity(productId) {
  try {
    const cart = JSON.parse(localStorage.getItem("cart") || "{}");
    const entry = cart[String(productId)];
    return Math.max(0, Number(entry?.q ?? entry?.count ?? 0) || 0);
  } catch (_error) {
    return 0;
  }
}

async function addAndShowCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No matched FairPrice products were provided.");
  }

  const tab = await chrome.tabs.create({
    active: false,
    url: "about:blank",
  });

  try {
    const results = [];
    const sendProgress = (details) => chrome.runtime.sendMessage({
      type: "FAIRPRICE_ADD_PROGRESS",
      ...details,
    }).catch(() => {});

    for (let index = 0; index < items.length; index += 1) {
      const { product, quantity } = items[index];
      const url = `https://www.fairprice.com.sg/product/${product.slug}-${product.clientItemId}`;
      const progress = {
        current: index + 1,
        total: items.length,
        productId: String(product.id),
        productName: product.name,
      };
      sendProgress({ ...progress, stage: "opening" });

      try {
        await navigateTabAndWait(tab.id, url);
        sendProgress({ ...progress, stage: "native" });
        const [{ result: before }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readFairPriceCartQuantity,
          args: [product.id],
        });

        let nativeResult;
        try {
          [{ result: nativeResult }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: tryNativeAdd,
            args: [product.id, quantity, 4_000],
          });
        } catch (error) {
          nativeResult = {
            verified: false,
            target: before + Math.max(1, Math.floor(Number(quantity) || 1)),
            reason: `native cart interaction failed: ${error.message}`,
          };
        }

        if (nativeResult.verified) {
          const result = {
            productId: String(product.id),
            productName: product.name,
            quantity: nativeResult.after,
            method: "native",
          };
          results.push(result);
          sendProgress({ ...progress, stage: "complete", method: result.method });
          continue;
        }

        sendProgress({ ...progress, stage: "fallback" });
        const [{ result: fallbackResult }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: setFairPriceCartQuantity,
          args: [product, nativeResult.target],
        });
        if (fallbackResult.quantity !== nativeResult.target) {
          throw new Error("The local-storage fallback did not reach the requested quantity.");
        }
        const result = {
          ...fallbackResult,
          productName: product.name,
          method: "localStorage",
          reason: nativeResult.reason,
        };
        results.push(result);
        sendProgress({ ...progress, stage: "complete", method: result.method });
      } catch (error) {
        const result = {
          productId: String(product.id),
          productName: product.name,
          method: "failed",
          reason: error.message,
        };
        results.push(result);
        sendProgress({ ...progress, stage: "complete", method: result.method });
      }
    }

    sendProgress({ stage: "finished", current: items.length, total: items.length });
    await chrome.tabs.update(tab.id, { active: true, url: FAIRPRICE_CART_URL });
    return results;
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
