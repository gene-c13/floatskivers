const FAIRPRICE_CART_URL = "https://www.fairprice.com.sg/cart";
const FAIRPRICE_SYNC_URL = "https://www.fairprice.com.sg/";

function navigateTabAndWait(tabId, url, timeoutMs = 10_000) {
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

async function executeScriptWhenReady(injection, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chrome.scripting.executeScript(injection);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw lastError || new Error("The FairPrice product document was not ready.");
}

async function waitForNativeAddButton(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = document.querySelector('button[data-testid="SvgAddToCart"]')
      || Array.from(document.querySelectorAll("button")).find((candidate) => {
        const label = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`;
        return /add\s*to\s*cart/i.test(label);
      });
    if (button && !button.disabled) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
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

// Reconciles every requested product in one localStorage read/write cycle.
// Native clicks from separate tabs may race, so this final atomic pass keeps
// every successful native entry and fills only missing products or quantities.
function reconcileFairPriceCart(entries) {
  const cart = JSON.parse(localStorage.getItem("cart") || "{}");
  const results = [];

  for (const { product, targetQuantity } of entries) {
    const productId = String(product?.id ?? "");
    if (!productId) continue;

    const target = Math.max(1, Math.floor(Number(targetQuantity) || 1));
    const existing = cart[productId];
    const current = Math.max(0, Number(existing?.q ?? existing?.count ?? 0) || 0);
    let changed = false;

    if (current < target) {
      changed = true;
      if (existing) {
        existing.q = String(target);
        existing.count = target;
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
          q: String(target),
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
          count: target,
          totalDiscount: 0,
        };
      }
    }

    results.push({ productId, target, changed });
  }

  localStorage.setItem("cart", JSON.stringify(cart));

  // FairPrice also caches a presentation-ready seller cart. Keep its item
  // quantities aligned so the cart page cannot rehydrate a stale quantity of
  // one over the reconciled `cart` record.
  try {
    const sellerCarts = JSON.parse(localStorage.getItem("sellerCart") || "null");
    if (Array.isArray(sellerCarts) && sellerCarts.length > 0) {
      const seller = sellerCarts.find((entry) => entry?.sellerInfo?.name === "FairPrice") || sellerCarts[0];
      seller.items = seller.items || {};

      for (const { productId } of results) {
        const cartEntry = cart[productId];
        if (!cartEntry) continue;
        if (seller.items[productId]) {
          seller.items[productId].q = cartEntry.q;
          seller.items[productId].count = cartEntry.count;
          seller.items[productId].t = cartEntry.t;
        } else {
          seller.items[productId] = cartEntry;
        }
      }

      const sellerItems = Object.values(seller.items);
      seller.sellerInfo.totalItemsQuantities = sellerItems.reduce(
        (sum, item) => sum + (Number(item.q ?? item.count ?? 0) || 0),
        0,
      );
      seller.sellerInfo.orderAmount = Number(sellerItems.reduce(
        (sum, item) => sum + ((Number(item.mrp ?? 0) || 0) * (Number(item.q ?? item.count ?? 0) || 0)),
        0,
      ).toFixed(2));
      localStorage.setItem("sellerCart", JSON.stringify(sellerCarts));
    }
  } catch (_error) {
    // The canonical cart is still valid; FairPrice can rebuild sellerCart.
  }

  const savedCart = JSON.parse(localStorage.getItem("cart") || "{}");
  return results.map((result) => ({
    ...result,
    quantity: Math.max(0, Number(savedCart[result.productId]?.q ?? savedCart[result.productId]?.count ?? 0) || 0),
  }));
}

function readFairPriceCartQuantities(productIds) {
  try {
    const cart = JSON.parse(localStorage.getItem("cart") || "{}");
    return Object.fromEntries(productIds.map((productId) => {
      const entry = cart[String(productId)];
      const quantity = Math.max(0, Number(entry?.q ?? entry?.count ?? 0) || 0);
      return [String(productId), quantity];
    }));
  } catch (_error) {
    return Object.fromEntries(productIds.map((productId) => [String(productId), 0]));
  }
}

async function addAndShowCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No matched FairPrice products were provided.");
  }

  // Product pages load in parallel, but cart mutations are serialized. Each
  // FairPrice tab reads and writes the whole guest-cart snapshot, so clicking
  // in several tabs at once can make the last writer erase another product.
  const tabs = await Promise.all(items.map(() => chrome.tabs.create({
    active: false,
    url: "about:blank",
  })));
  try {
    const results = [];
    const sendProgress = (details) => chrome.runtime.sendMessage({
      type: "FAIRPRICE_ADD_PROGRESS",
      ...details,
    }).catch(() => {});

    let preparedCount = 0;
    let nativeStarted = false;
    sendProgress({ stage: "preloading", current: 0, total: items.length });
    const readiness = items.map(async ({ product, quantity }, index) => {
      const tab = tabs[index];
      const url = `https://www.fairprice.com.sg/product/${product.slug}`;
      try {
        await navigateTabAndWait(tab.id, url);
        const [{ result: nativeButtonReady }] = await executeScriptWhenReady({
          target: { tabId: tab.id },
          func: waitForNativeAddButton,
          args: [4_000],
        });
        return { product, quantity, tab, nativeButtonReady };
      } catch (error) {
        return { product, quantity, tab, nativeButtonReady: false, prepareError: error };
      } finally {
        preparedCount += 1;
        if (!nativeStarted) {
          sendProgress({
            stage: "preloaded",
            current: preparedCount,
            total: items.length,
            productId: String(product.id),
            productName: product.name,
          });
        }
      }
    });

    // Attach consumers now so jobs retain their actual readiness order even
    // when several pages become interactive while the cart snapshot is read.
    // The gate prevents any click until that snapshot is safely captured.
    let releaseNativeQueue;
    const nativeQueueGate = new Promise((resolve) => {
      releaseNativeQueue = resolve;
    });
    const queuedReadiness = readiness.map(async (ready, index) => {
      const job = await ready;
      await nativeQueueGate;
      return enqueueNativeMutation(job, index);
    });

    // Only the first usable FairPrice page gates the initial cart snapshot.
    // Every other page continues preparing independently in the background.
    let storageJob;
    try {
      storageJob = await Promise.any(readiness.map((ready) => ready.then((job) => {
        if (job.prepareError) throw job.prepareError;
        return job;
      })));
    } catch (_error) {
      storageJob = await readiness[0];
    }
    const storageTab = storageJob.tab;
    const productIds = items.map(({ product }) => String(product.id));
    const [{ result: initialQuantities }] = await executeScriptWhenReady({
      target: { tabId: storageTab.id },
      func: readFairPriceCartQuantities,
      args: [productIds],
    });

    // Accumulate targets so two ingredients selecting the same FairPrice SKU
    // still produce the combined quantity instead of racing each other.
    const targetByProductId = { ...initialQuantities };
    for (const { product, quantity } of items) {
      const productId = String(product.id);
      targetByProductId[productId] = (targetByProductId[productId] || 0)
        + Math.max(1, Math.floor(Number(quantity) || 1));
    }

    nativeStarted = true;
    sendProgress({
      stage: "streaming_native",
      current: 0,
      completed: 0,
      total: items.length,
    });

    let nativeCompleted = 0;
    let mutationChain = Promise.resolve();
    const nativeAttempts = Array(items.length);

    function enqueueNativeMutation(job, index) {
      const queuedMutation = mutationChain.then(async () => {
        const { product, quantity, tab, nativeButtonReady, prepareError } = job;
        let nativeResult = {
          verified: false,
          reason: prepareError?.message || "native add button unavailable",
        };

        sendProgress({
          stage: "native",
          current: index + 1,
          completed: nativeCompleted,
          total: items.length,
          productId: String(product.id),
          productName: product.name,
        });

        if (!prepareError && nativeButtonReady) {
          try {
            [{ result: nativeResult }] = await executeScriptWhenReady({
              target: { tabId: tab.id },
              func: tryNativeAdd,
              args: [product.id, quantity, 2_500],
            });
          } catch (error) {
            nativeResult = { verified: false, reason: error.message };
          }
        }

        // Give FairPrice's cart state listeners a brief chance to finish their
        // own write before the next product reads the shared cart snapshot.
        await new Promise((resolve) => setTimeout(resolve, 180));

        nativeAttempts[index] = nativeResult;
        nativeCompleted += 1;
        sendProgress({
          stage: "native_result",
          current: index + 1,
          completed: nativeCompleted,
          total: items.length,
          productId: String(product.id),
          productName: product.name,
          nativeVerified: nativeResult.verified,
        });
        return nativeResult;
      });

      // Keep the queue usable even if an unexpected job error escapes. Normal
      // native failures are captured above and repaired by reconciliation.
      mutationChain = queuedMutation.catch(() => {});
      return queuedMutation;
    }

    // Release every page that is already ready, in readiness order. Pages that
    // finish later join the same queue immediately and never wait for the
    // slowest product page.
    releaseNativeQueue();
    await Promise.all(queuedReadiness);
    await mutationChain;

    sendProgress({ stage: "reconciling", current: items.length, total: items.length });
    const uniqueProducts = new Map();
    for (const { product } of items) uniqueProducts.set(String(product.id), product);
    const reconciliationEntries = Array.from(uniqueProducts, ([productId, product]) => ({
      product,
      targetQuantity: targetByProductId[productId],
    }));

    // Destroy every product page before the final write so a late native event
    // cannot overwrite the reconciled cart. Reuse the first-ready tab only as
    // a short-lived same-origin coordinator, then navigate it to the cart.
    await Promise.all(tabs
      .filter((tab) => tab.id !== storageTab.id)
      .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
    await navigateTabAndWait(storageTab.id, FAIRPRICE_SYNC_URL);
    const [{ result: reconciliation }] = await executeScriptWhenReady({
      target: { tabId: storageTab.id },
      func: reconcileFairPriceCart,
      args: [reconciliationEntries],
    });
    const reconciliationById = Object.fromEntries(reconciliation.map((entry) => [entry.productId, entry]));

    for (let index = 0; index < items.length; index += 1) {
      const { product } = items[index];
      const productId = String(product.id);
      const reconciled = reconciliationById[productId];
      const reachedTarget = reconciled?.quantity >= targetByProductId[productId];
      const method = reachedTarget
        ? (reconciled.changed ? "localStorage" : "native")
        : "failed";
      const result = {
        productId,
        productName: product.name,
        quantity: reconciled?.quantity || 0,
        method,
        reason: method === "failed"
          ? "cart reconciliation did not reach the requested quantity"
          : nativeAttempts[index]?.reason,
      };
      results.push(result);
      sendProgress({
        stage: "complete",
        current: index + 1,
        total: items.length,
        productId,
        productName: product.name,
        method,
      });
    }

    sendProgress({ stage: "finished", current: items.length, total: items.length });
    await chrome.tabs.update(storageTab.id, { active: true, url: FAIRPRICE_CART_URL });
    return results;
  } catch (error) {
    await Promise.all(tabs.map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
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
