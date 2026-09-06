"""search_products / add_to_cart.

search_products is a real FairPrice integration: it hits the same live
search endpoint as extension/popup.js's searchFairPrice(), and ranks
results with a line-for-line port of that file's scoreProduct() and
chooseBestProduct(), so an agent run and a person using the extension are
looking at candidates ranked by the same signal. The one difference from
the extension is deliberate — search_products returns the top few ranked
candidates instead of collapsing to a single pick, so the model can still
reason over them before calling add_to_cart (see CONTRACT.md).

add_to_cart is still stubbed. background.js's real version only works
inside an actual browser tab (it injects a script into a live FairPrice
page and writes to that page's own localStorage) — there's no headless/API
equivalent yet, so this can't be made real until the cart team exposes one.
"""
import json
import re

import requests

FAIRPRICE_SEARCH_URL = "https://www.fairprice.com.sg/search?query="

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_NEXT_DATA_RE = re.compile(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL)

# Port of popup.js's searchableWords()'s ignore list.
_IGNORED_WORDS = {"and", "of", "the", "a", "an", "fresh"}


def _searchable_words(text: str) -> list:
    text = re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()
    return [w for w in text.split() if w and w not in _IGNORED_WORDS]


def _pack_amount_in_grams(display_unit):
    """Port of popup.js's packAmountInGrams(). None if it can't be parsed."""
    if not display_unit:
        return None
    text = re.sub(r"\s+", "", str(display_unit).lower())

    multipack = re.match(r"(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(kg|g)\b", text)
    if multipack:
        count, each, unit = multipack.groups()
        each_grams = float(each) * (1000 if unit == "kg" else 1)
        return float(count) * each_grams

    single = re.match(r"(\d+(?:\.\d+)?)(kg|g)\b", text)
    if not single:
        return None
    amount, unit = single.groups()
    return float(amount) * (1000 if unit == "kg" else 1)


def _pack_size_of_raw(product: dict) -> str:
    meta = product.get("metaData") or {}
    return meta.get("DisplayUnit") or meta.get("Unit Of Weight") or ""


def score_product(query: str, quantity, unit, product: dict, index: int) -> float:
    """Port of popup.js's scoreProduct(). `product` is a raw FairPrice
    product dict (as returned by search_fairprice_raw), not the simplified
    shape search_products() hands back to the agent."""
    if product.get("has_stock") is False:
        return float("-inf")

    meta = product.get("metaData") or {}
    query_words = _searchable_words(query)
    product_words_list = _searchable_words(f"{product.get('name', '')} {meta.get('SAP Product Name', '')}")
    product_words = set(product_words_list)
    matching = sum(1 for w in query_words if w in product_words)
    score = matching * 100 - max(0, len(product_words_list) - len(query_words)) * 0.5 - index

    if query.lower() in str(product.get("name", "")).lower():
        score += 80
    if str((product.get("brand") or {}).get("name", "")).lower() == "fairprice":
        score += 3

    if unit == "g" and quantity and float(quantity) > 0:
        pack_grams = _pack_amount_in_grams(_pack_size_of_raw(product))
        if pack_grams:
            quantity = float(quantity)
            packs = -(-quantity // pack_grams)  # ceil
            excess_ratio = ((packs * pack_grams) - quantity) / quantity
            score += 30 - min(25, excess_ratio * 10)

    return score


def recommended_pack_count(quantity, unit, candidate: dict) -> int:
    """Port of popup.js's recommendedPackCount(): how many packs of this
    candidate are needed to cover the required quantity."""
    if unit == "g" and quantity:
        quantity = float(quantity)
        pack_grams = _pack_amount_in_grams(candidate.get("pack_size"))
        if pack_grams and quantity > 0:
            return max(1, int(-(-quantity // pack_grams)))
    if unit == "whole" and quantity:
        return max(1, int(-(-float(quantity) // 1)))
    return 1


def choose_best_product(query: str, quantity, unit, raw_products: list):
    """Port of popup.js's chooseBestProduct(): the single best raw product,
    or None if every candidate is out of stock / unscoreable."""
    scored = [
        (score_product(query, quantity, unit, product, index), product)
        for index, product in enumerate(raw_products)
    ]
    scored = [(s, p) for s, p in scored if s != float("-inf")]
    if not scored:
        return None
    return max(scored, key=lambda pair: pair[0])[1]


def search_fairprice_raw(query: str) -> list:
    """Port of popup.js's searchFairPrice(): the raw FairPrice product
    listings for a query, straight off their live search page."""
    response = requests.get(FAIRPRICE_SEARCH_URL + query, headers=_HEADERS, timeout=15)
    response.raise_for_status()

    match = _NEXT_DATA_RE.search(response.text)
    if not match:
        return []
    data = json.loads(match.group(1))
    layouts = (
        data.get("props", {}).get("pageProps", {}).get("data", {})
        .get("data", {}).get("page", {}).get("layouts", [])
    )
    collection = next((l for l in layouts if l.get("name") == "ProductCollection"), None)
    raw_products = (collection or {}).get("value", {}).get("collection", {}).get("product", [])
    return [p for p in raw_products if p.get("id") and p.get("name") and p.get("slug") and p.get("clientItemId")]


def _to_candidate(product: dict) -> dict:
    """Raw FairPrice product -> the CONTRACT.md #2 shape (plus has_stock,
    which chooseBestProduct/scoreProduct need to exclude out-of-stock
    items)."""
    store_data = product.get("storeSpecificData")
    if isinstance(store_data, list):
        store_data = store_data[0] if store_data else {}
    store_data = store_data or {}

    price = product.get("final_price")
    if price is None:
        price = store_data.get("mrp")
    if price is None:
        price = product.get("mrp")
    if price is None:
        price = 0

    return {
        "product_id": str(product["id"]),
        "name": product["name"],
        "brand": (product.get("brand") or {}).get("name", ""),
        "price": round(float(price), 2),
        "pack_size": _pack_size_of_raw(product),
        "has_stock": product.get("has_stock", True),
    }


# Words after which FairPrice's search tends to choke on a trailing clause
# that isn't really part of the product name — "olive oil for frying"
# returns nothing, "olive oil" returns twenty results.
_TRAILING_CLAUSE_WORDS = {"for", "to", "with", "using"}


def _relaxed_search_queries(query: str):
    """Yield `query`, then progressively broader variants, for when
    FairPrice's search is too literal to match the ingredient's exact
    wording. Every variant after the first means whatever it finds is a
    substitute for what was actually asked, not a confirmed match — the
    caller (agent.py's choose_product_for_item) treats that as always
    needing the model's judgment and a clear "this is a substitute" flag,
    never the fast deterministic path.
    """
    yield query

    words = query.split()

    # Drop a trailing "for X"/"to X" clause: "olive oil for frying" -> "olive oil".
    for i, word in enumerate(words):
        if i > 0 and word.lower() in _TRAILING_CLAUSE_WORDS:
            trimmed = " ".join(words[:i])
            if trimmed:
                yield trimmed
            break

    # Then drop leading words one at a time: "fresh mozzarella" -> "mozzarella",
    # "prepared tomato sauce" -> "tomato sauce".
    for i in range(1, len(words)):
        candidate = " ".join(words[i:])
        if candidate:
            yield candidate


def search_and_rank_raw(query: str, quantity=None, unit=None, limit: int = 5):
    """Search + rank, keeping the raw FairPrice objects around (not just
    the simplified candidate shape). Needed wherever a pick has to be
    handed to background.js's cart-adding, which requires the full raw
    product (slug, clientItemId, storeSpecificData, ...) — the simplified
    shape only carries what the model needs to reason about.

    Tries `query` as-is first; if that turns up nothing (no results, or
    every result out of stock), retries with progressively broader
    variants (see _relaxed_search_queries) so an out-of-stock or
    oddly-worded ingredient still surfaces a real substitute instead of a
    flat "no matches" — ranking always scores against the *original*
    query's wording, only the FairPrice search itself uses the broadened
    one.

    Returns (candidates, raw_by_id, scores, is_substitute): candidates is
    CONTRACT.md's #2 shape, ranked best-first; raw_by_id maps each
    candidate's product_id back to its raw FairPrice object; scores lines
    up with candidates; is_substitute is True when a broadened query was
    needed to find anything at all.
    """
    top_scored = []
    is_substitute = False

    for attempt_index, attempt_query in enumerate(_relaxed_search_queries(query)):
        try:
            raw_products = search_fairprice_raw(attempt_query)
        except requests.RequestException as exc:
            print(f"      [search failed: {exc}]")
            return [], {}, [], False

        scored = [
            (score_product(query, quantity, unit, product, index), product)
            for index, product in enumerate(raw_products)
        ]
        scored = [(s, p) for s, p in scored if s != float("-inf")]
        if scored:
            is_substitute = attempt_index > 0
            scored.sort(key=lambda pair: pair[0], reverse=True)
            top_scored = scored[:limit]
            break

    candidates = [_to_candidate(p) for _, p in top_scored]
    raw_by_id = {c["product_id"]: p for c, (_, p) in zip(candidates, top_scored)}
    scores = [s for s, _ in top_scored]
    return candidates, raw_by_id, scores, is_substitute


def search_products(query: str, quantity=None, unit=None) -> list:
    """Real FairPrice search, ranked with the same scoring the shipped
    extension uses. quantity/unit are optional — pass the shopping-list
    item's values when known so pack-size fit is scored too, same as
    chooseBestProduct does; without them this still ranks on name-match
    alone.
    """
    print(f"      [tool] search_products({query!r}, quantity={quantity!r}, unit={unit!r})")
    candidates, _, _, _ = search_and_rank_raw(query, quantity, unit)
    return candidates


def add_to_cart(product_id: str, quantity: int) -> dict:
    print(f"      [tool] add_to_cart({product_id!r}, {quantity!r}) — stubbed, see module docstring")
    return {
        "status": "added",
        "product_id": product_id,
        "quantity": quantity,
    }
