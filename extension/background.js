const FAIRPRICE_CART_URL = "https://www.fairprice.com.sg/cart";
const FAIRPRICE_SYNC_URL = "https://www.fairprice.com.sg/";
const PENDING_CART_KEY = "pendingFairPriceCart";

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
  let verifiedByNativeControl = false;
  if (after <= before) {
    // Signed-in FairPrice carts are account-backed and may not mirror their
    // quantity into the guest `cart` key. The product quantity stepper replacing
    // the Add button is the native UI confirmation in that session mode.
    const incrementButton = await waitFor(findIncrementButton, 1_500);
    if (!incrementButton || incrementButton.disabled) {
      return { before, after, target, verified: false, reason: "cart quantity did not change" };
    }
    verifiedByNativeControl = true;
    after = before + 1;
  }

  while (after < target) {
    const incrementButton = await waitFor(findIncrementButton, 1_500);
    if (!incrementButton || incrementButton.disabled) break;
    const previous = after;
    incrementButton.click();
    if (verifiedByNativeControl) {
      await sleep(300);
      if (!findIncrementButton()) break;
      after = previous + 1;
    } else {
      after = await waitForQuantityAbove(previous, 2_500);
      if (after <= previous) break;
    }
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

async function inspectFairPriceSession(timeoutMs) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controls = Array.from(document.querySelectorAll("button, a"));
    const textFor = (element) => `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim();
    const hasExactLabel = (element, pattern) => {
      const ariaLabel = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const visibleText = (element.textContent || "").replace(/\s+/g, " ").trim();
      return pattern.test(ariaLabel) || pattern.test(visibleText);
    };
    const locationControl = controls.find((element) => /enter your address or postal code/i.test(textFor(element)));
    const loginControl = controls.find((element) => hasExactLabel(element, /^(log in|sign in)$/i));
    const accountControl = controls.find((element) => hasExactLabel(element, /^(account|my account|profile)$/i));

    if (locationControl || loginControl || accountControl) {
      return {
        requiresLocation: Boolean(locationControl),
        isLoggedIn: !loginControl,
      };
    }
    await sleep(150);
  }

  // Fail closed: an unknown header state must not be treated as a guest cart,
  // because synthetic localStorage writes are unsafe for signed-in accounts.
  return { requiresLocation: false, isLoggedIn: true, uncertain: true };
}

function openFairPriceLocationSelector() {
  const control = Array.from(document.querySelectorAll("button, a")).find((element) => {
    const label = `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`;
    return /enter your address or postal code/i.test(label);
  });
  if (!control) return false;
  control.click();
  return true;
}

async function pointToFairPriceLocationInput(timeoutMs) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const deadline = Date.now() + timeoutMs;

  function findInput() {
    const direct = document.querySelector([
      'input[placeholder*="address" i]',
      'input[placeholder*="postal" i]',
      'input[aria-label*="address" i]',
      'input[aria-label*="postal" i]',
    ].join(","));
    if (direct) return direct;

    return Array.from(document.querySelectorAll("input")).find((input) => {
      const nearbyText = input.parentElement?.parentElement?.textContent || input.parentElement?.textContent || "";
      return /address or postal code/i.test(nearbyText);
    }) || null;
  }

  let input = findInput();
  while (!input && Date.now() < deadline) {
    await sleep(100);
    input = findInput();
  }
  if (!input) return false;

  let field = input;
  for (let parent = input.parentElement, depth = 0; parent && depth < 3; parent = parent.parentElement, depth += 1) {
    const rect = parent.getBoundingClientRect();
    if (rect.width >= input.getBoundingClientRect().width && rect.height >= 44 && rect.height <= 110) {
      field = parent;
    }
  }
  field.dataset.recipeCartLocationTarget = "true";
  field.dataset.recipeCartOldOutline = field.style.outline;
  field.dataset.recipeCartOldOutlineOffset = field.style.outlineOffset;
  field.dataset.recipeCartOldBoxShadow = field.style.boxShadow;
  field.style.setProperty("outline", "3px solid #ff7a1a", "important");
  field.style.setProperty("outline-offset", "3px", "important");
  field.style.setProperty("box-shadow", "0 0 0 8px rgba(255,122,26,.2), 0 10px 28px rgba(229,85,49,.22)", "important");

  let callout = document.getElementById("recipe-cart-location-callout-host");
  if (!callout) {
    callout = document.createElement("div");
    callout.id = "recipe-cart-location-callout-host";
    callout.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none";
    document.documentElement.appendChild(callout);
    const shadow = callout.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all:initial; }
        .bubble { position:relative; width:240px; box-sizing:border-box; padding:13px 15px;
          border:1px solid rgba(255,255,255,.9); border-radius:15px; color:#17352a;
          background:linear-gradient(145deg,#fffdf9,#fff5e9); box-shadow:0 14px 34px rgba(28,48,40,.24);
          font:600 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          animation:nudge 1.25s ease-in-out infinite; }
        .bubble::before { content:""; position:absolute; width:0; height:0; filter:drop-shadow(-2px 1px 1px rgba(28,48,40,.08)); }
        .bubble.right::before { left:-13px; top:23px; border-top:11px solid transparent;
          border-bottom:11px solid transparent; border-right:13px solid #fffaf3; }
        .bubble.below::before { left:25px; top:-13px; border-left:11px solid transparent;
          border-right:11px solid transparent; border-bottom:13px solid #fffaf3; }
        .title { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:800; }
        .arrow { display:grid; place-items:center; width:24px; height:24px; flex:none; border-radius:8px;
          color:#fff; background:linear-gradient(135deg,#e55531,#f3a12d); font-size:16px; }
        .hint { margin:4px 0 0 32px; color:#677c73; font-size:11px; font-weight:600; }
        @keyframes nudge { 0%,100% { transform:translateX(0) } 50% { transform:translateX(-5px) } }
        .bubble.below { animation-name:nudgeDown; }
        @keyframes nudgeDown { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-4px) } }
      </style>
      <div class="bubble right" data-callout-bubble>
        <div class="title"><span class="arrow">←</span><span>Enter your address here</span></div>
        <div class="hint">We’ll continue adding automatically.</div>
      </div>`;
  }

  const positionCallout = () => {
    if (!field.isConnected || !callout.isConnected) return;
    const rect = field.getBoundingClientRect();
    const bubble = callout.shadowRoot?.querySelector("[data-callout-bubble]");
    const fitsRight = rect.right + 270 <= window.innerWidth;
    if (fitsRight) {
      callout.style.left = `${Math.round(rect.right + 18)}px`;
      callout.style.top = `${Math.max(12, Math.round(rect.top + (rect.height / 2) - 34))}px`;
      if (bubble) bubble.className = "bubble right";
    } else {
      callout.style.left = `${Math.max(12, Math.min(window.innerWidth - 258, Math.round(rect.left + 18)))}px`;
      callout.style.top = `${Math.min(window.innerHeight - 100, Math.round(rect.bottom + 18))}px`;
      if (bubble) bubble.className = "bubble below";
    }
  };

  if (window.__recipeCartLocationPositioner) {
    window.removeEventListener("resize", window.__recipeCartLocationPositioner);
  }
  window.__recipeCartLocationPositioner = positionCallout;
  window.addEventListener("resize", positionCallout);
  positionCallout();
  input.focus({ preventScroll: true });
  return true;
}

function watchForFairPriceLocationSelection(runId) {
  if (window.__recipeCartLocationWatcher === runId) return;
  window.__recipeCartLocationWatcher = runId;

  const stillNeedsLocation = () => Array.from(document.querySelectorAll("button, a")).some((element) => {
    const label = `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`;
    return /enter your address or postal code/i.test(label);
  });

  let sent = false;
  const check = () => {
    if (sent || stillNeedsLocation()) return;
    sent = true;
    observer.disconnect();
    clearInterval(intervalId);
    document.getElementById("recipe-cart-location-callout-host")?.remove();
    const guidedField = document.querySelector('[data-recipe-cart-location-target="true"]');
    if (guidedField) {
      guidedField.style.outline = guidedField.dataset.recipeCartOldOutline || "";
      guidedField.style.outlineOffset = guidedField.dataset.recipeCartOldOutlineOffset || "";
      guidedField.style.boxShadow = guidedField.dataset.recipeCartOldBoxShadow || "";
      delete guidedField.dataset.recipeCartLocationTarget;
    }
    if (window.__recipeCartLocationPositioner) {
      window.removeEventListener("resize", window.__recipeCartLocationPositioner);
      delete window.__recipeCartLocationPositioner;
    }
    const progressHost = document.getElementById("recipe-cart-progress-host");
    const progressRoot = progressHost?.shadowRoot;
    if (progressRoot) {
      const stage = progressRoot.querySelector("[data-progress-stage]");
      const product = progressRoot.querySelector("[data-progress-product]");
      const badge = progressRoot.querySelector("[data-progress-badge]");
      if (stage) stage.textContent = "Location saved — starting your cart automatically…";
      if (product) product.textContent = "Preparing product pages";
      if (badge) badge.textContent = "Resuming";
    }
    chrome.runtime.sendMessage({
      type: "FAIRPRICE_LOCATION_SELECTED",
      runId,
    }).catch(() => {});
  };

  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  const intervalId = setInterval(check, 1_000);
  setTimeout(() => {
    observer.disconnect();
    clearInterval(intervalId);
  }, 10 * 60 * 1_000);
  check();
}

function renderFairPriceCartProgress(message) {
  let host = document.getElementById("recipe-cart-progress-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "recipe-cart-progress-host";
    host.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;pointer-events:none";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          width: 340px; box-sizing: border-box; padding: 18px; overflow: hidden;
          border: 1px solid rgba(255,255,255,.7); border-radius: 20px;
          background: rgba(250,252,250,.96); color: #17352a;
          box-shadow: 0 20px 55px rgba(20,55,42,.22), 0 3px 12px rgba(20,55,42,.1);
          font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          backdrop-filter: blur(16px); animation: enter .36s cubic-bezier(.2,.8,.2,1) both;
        }
        .top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .brand { display:flex; align-items:center; gap:9px; font-weight:800; letter-spacing:-.01em; }
        .mark { display:grid; place-items:center; width:28px; height:28px; border-radius:9px; color:#fff;
          background:linear-gradient(135deg,#e55531,#f3a12d); box-shadow:0 6px 16px rgba(229,85,49,.25); }
        .badge { padding:5px 9px; border-radius:999px; color:#9a4c18; background:#fff0df;
          font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
        .product { margin-top:15px; font-size:16px; font-weight:800; letter-spacing:-.015em; }
        .stage { min-height:38px; margin-top:4px; color:#577066; font-size:13px; }
        .track { height:7px; margin-top:14px; overflow:hidden; border-radius:999px; background:#e2ebe6; }
        .bar { width:3%; height:100%; border-radius:inherit; background:linear-gradient(90deg,#e55531,#f3a12d);
          box-shadow:0 0 14px rgba(242,140,40,.38); transition:width .35s ease; }
        .foot { display:flex; justify-content:space-between; margin-top:9px; color:#789087; font-size:11px; font-weight:700; }
        .pulse { display:inline-block; width:6px; height:6px; margin-right:6px; border-radius:50%; background:#f28c28;
          box-shadow:0 0 0 0 rgba(242,140,40,.35); animation:pulse 1.25s infinite; }
        @keyframes enter { from { opacity:0; transform:translateY(14px) scale(.97) } }
        @keyframes pulse { 70% { box-shadow:0 0 0 7px rgba(242,140,40,0) } 100% { box-shadow:0 0 0 0 rgba(242,140,40,0) } }
      </style>
      <section class="card" role="status" aria-live="polite">
        <div class="top"><div class="brand"><span class="mark">✓</span>Recipe Cart</div><span class="badge" data-progress-badge>Working</span></div>
        <div class="product" data-progress-product>Preparing your cart</div>
        <div class="stage" data-progress-stage>Connecting to FairPrice…</div>
        <div class="track"><div class="bar" data-progress-bar></div></div>
        <div class="foot"><span><span class="pulse"></span><span data-progress-status>Working in background</span></span><span data-progress-count>0 / 0</span></div>
      </section>`;
  }

  const root = host.shadowRoot;
  if (!root) return;
  const total = Math.max(1, Number(message.total) || 1);
  const current = Math.max(0, Number(message.current) || 0);
  const completed = Math.max(0, Number(message.completed) || 0);
  const stage = message.stage || "preloading";
  let percentage = 3;
  if (stage === "preloaded") percentage = Math.round((current / total) * 27);
  else if (["checking_session", "guest_session", "signed_in_session"].includes(stage)) percentage = 29;
  else if (stage === "streaming_native") percentage = 32;
  else if (["native", "native_result"].includes(stage)) percentage = 32 + Math.round((completed / total) * 48);
  else if (stage === "reconciling") percentage = 82;
  else if (stage === "complete") percentage = 82 + Math.round((current / total) * 18);
  else if (stage === "finished") percentage = 100;

  const labels = {
    waiting_for_location: "Follow the orange pointer and enter your delivery address. Adding will resume automatically.",
    preloading: "Opening product pages in the background…",
    preloaded: `Prepared ${current} of ${total} product pages…`,
    checking_session: "Checking your FairPrice session…",
    guest_session: "Guest cart ready — native adding with safe fallback.",
    signed_in_session: "Signed-in account cart ready.",
    streaming_native: "Adding products as soon as they are ready…",
    native: `Adding ${message.productName || "this product"}…`,
    native_result: message.nativeVerified
      ? `Added ${completed} of ${total} products.`
      : `Checked ${completed} of ${total}; safe recovery is queued.`,
    reconciling: "Verifying every product and requested quantity…",
    complete: message.method === "failed" ? "This product could not be added." : "Product verified in cart.",
    finished: "Everything is ready — opening your FairPrice cart…",
  };
  const displayCount = ["native", "native_result", "streaming_native"].includes(stage) ? completed : current;
  const badgeText = stage === "waiting_for_location" ? "Action needed" : stage === "finished" ? "Complete" : "Adding";
  const productText = message.productName
    || (stage === "waiting_for_location" ? "Delivery location required" : "Preparing your cart");

  root.querySelector("[data-progress-product]").textContent = productText;
  root.querySelector("[data-progress-stage]").textContent = labels[stage] || "Working in the background…";
  root.querySelector("[data-progress-bar]").style.width = `${Math.min(100, percentage)}%`;
  root.querySelector("[data-progress-count]").textContent = `${displayCount} / ${total}`;
  root.querySelector("[data-progress-badge]").textContent = badgeText;
  root.querySelector("[data-progress-status]").textContent = stage === "waiting_for_location"
    ? "Waiting for you"
    : stage === "finished" ? "Cart ready" : "Working in background";
}

async function addAndShowCart(items, options = {}) {
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
    let mirroredProgress = Promise.resolve();
    const sendProgress = (details) => {
      chrome.runtime.sendMessage({
        type: "FAIRPRICE_ADD_PROGRESS",
        ...details,
      }).catch(() => {});
      if (options.progressTabId) {
        mirroredProgress = mirroredProgress.then(() => chrome.scripting.executeScript({
          target: { tabId: options.progressTabId },
          func: renderFairPriceCartProgress,
          args: [details],
        })).catch(() => {});
      }
    };

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
    let abortNativeQueue = false;
    const nativeQueueGate = new Promise((resolve) => {
      releaseNativeQueue = resolve;
    });
    const queuedReadiness = readiness.map(async (ready, index) => {
      const job = await ready;
      await nativeQueueGate;
      if (abortNativeQueue) {
        return { verified: false, reason: "delivery location required" };
      }
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
    sendProgress({
      stage: "checking_session",
      current: 0,
      total: items.length,
      productName: "Checking FairPrice delivery and account session",
    });
    const [{ result: sessionInfo }] = await executeScriptWhenReady({
      target: { tabId: storageTab.id },
      func: inspectFairPriceSession,
      args: [3_000],
    });

    if (sessionInfo.requiresLocation) {
      abortNativeQueue = true;
      releaseNativeQueue();
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sendProgress({
        stage: "location_required",
        current: 0,
        total: items.length,
        productName: "Choose your delivery location on FairPrice",
      });
      await Promise.all(tabs
        .filter((tab) => tab.id !== storageTab.id)
        .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
      await chrome.storage.session.set({
        [PENDING_CART_KEY]: {
          runId,
          items,
          promptTabId: storageTab.id,
          createdAt: Date.now(),
          status: "waiting_for_location",
        },
      });
      await executeScriptWhenReady({
        target: { tabId: storageTab.id },
        func: watchForFairPriceLocationSelection,
        args: [runId],
      });
      await executeScriptWhenReady({
        target: { tabId: storageTab.id },
        func: renderFairPriceCartProgress,
        args: [{
          stage: "waiting_for_location",
          current: 0,
          total: items.length,
          productName: "Delivery location required",
        }],
      });
      await executeScriptWhenReady({
        target: { tabId: storageTab.id },
        func: openFairPriceLocationSelector,
      }).catch(() => {});
      await executeScriptWhenReady({
        target: { tabId: storageTab.id },
        func: pointToFairPriceLocationInput,
        args: [3_500],
      }).catch(() => {});
      await chrome.tabs.update(storageTab.id, { active: true });
      return { status: "location_required", autoResume: true };
    }

    sendProgress({
      stage: sessionInfo.isLoggedIn ? "signed_in_session" : "guest_session",
      current: 0,
      total: items.length,
      productName: sessionInfo.isLoggedIn ? "Signed-in FairPrice cart" : "FairPrice guest cart",
    });
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

    // Signed-in carts belong to FairPrice's server-side account session. Native
    // clicks are the source of truth and must never be overwritten with a
    // synthetic guest localStorage record.
    if (sessionInfo.isLoggedIn) {
      await Promise.all(tabs
        .filter((tab) => tab.id !== storageTab.id)
        .map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));

      for (let index = 0; index < items.length; index += 1) {
        const { product } = items[index];
        const nativeResult = nativeAttempts[index];
        const method = nativeResult?.verified ? "native" : "failed";
        const result = {
          productId: String(product.id),
          productName: product.name,
          quantity: nativeResult?.after || 0,
          method,
          reason: nativeResult?.reason,
        };
        results.push(result);
        sendProgress({
          stage: "complete",
          current: index + 1,
          total: items.length,
          productId: String(product.id),
          productName: product.name,
          method,
        });
      }

      sendProgress({ stage: "finished", current: items.length, total: items.length });
      await mirroredProgress;
      await chrome.tabs.update(storageTab.id, { active: true, url: FAIRPRICE_CART_URL });
      return results;
    }

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
    await mirroredProgress;
    await chrome.tabs.update(storageTab.id, { active: true, url: FAIRPRICE_CART_URL });
    return results;
  } catch (error) {
    await Promise.all(tabs.map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
    throw error;
  }
}

async function resumePendingFairPriceCart(runId, senderTabId) {
  const stored = await chrome.storage.session.get(PENDING_CART_KEY);
  const pending = stored[PENDING_CART_KEY];
  if (!pending || pending.runId !== runId || pending.status !== "waiting_for_location") return;

  pending.status = "resuming";
  await chrome.storage.session.set({ [PENDING_CART_KEY]: pending });
  try {
    await addAndShowCart(pending.items, {
      progressTabId: senderTabId || pending.promptTabId,
    });
  } finally {
    // A second location handoff may have replaced this run. Only clear the
    // record we claimed, never a newer pending cart.
    const latest = (await chrome.storage.session.get(PENDING_CART_KEY))[PENDING_CART_KEY];
    if (latest?.runId === runId) await chrome.storage.session.remove(PENDING_CART_KEY);
    const promptTabId = senderTabId || pending.promptTabId;
    if (promptTabId) await chrome.tabs.remove(promptTabId).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FAIRPRICE_LOCATION_SELECTED") {
    resumePendingFairPriceCart(message.runId, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "ADD_FAIRPRICE_PRODUCTS") return;

  addAndShowCart(message.items)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
