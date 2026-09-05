# Data contract — recipe team ↔ agent ↔ cart team

Everyone builds against these shapes independently — no need to wait on
each other. The recipe team owns parsing/merging (#1, #1b), the cart team
owns search/ranking/cart-adding (#2, #4, both in the browser extension),
and the agent's whole job is the decision in between (#3).

## 1. `parse_recipe(url_or_text)` — owned by the recipe team

**Implemented** in `recipe_parser/parse_recipe.py`. Called once per recipe.
Returns the whole thing, ingredients included.

```json
{
  "title": "Chicken Stir Fry",
  "servings": 4,
  "ingredients": [
    {"name": "chicken breast", "quantity": 500, "unit": "g", "raw_text": "500g chicken breast, diced"},
    {"name": "garlic", "quantity": 3, "unit": "cloves", "raw_text": "3 cloves garlic, minced"}
  ]
}
```

Notes:
- `raw_text` is the original line from the recipe — kept in case the agent
  needs more context than the parsed fields give it.
- Resolved: vague lines like "salt to taste" come back with
  `quantity: null, unit: null` rather than being dropped — the "to taste"
  suffix is stripped from `name`. Whether to act on those at all is handled
  downstream, see `build_shopping_list` below.

## 1b. `build_shopping_list(recipes)` — owned by the recipe team

**Implemented** in `recipe_parser/shopping_list.py`. Not in the original
contract — added once real recipes showed unit mismatches across the same
ingredient (e.g. "3 cloves garlic" in one recipe, "1 tsp minced garlic" in
another) that the agent shouldn't have to reconcile itself. Takes a list of
`parse_recipe()` outputs (i.e. call `parse_recipe` once per recipe URL
first, then pass all of them in together) and merges by ingredient name,
converting to grams where it can.

Returns `(shopping_list, skipped)`:

```json
[
  {"name": "garlic", "quantity": 9.0, "unit": "g", "sources": ["Chicken Stir Fry", "Garlic Rice"]},
  {"name": "chili", "quantity": 1, "unit": "whole", "sources": ["Chicken Stir Fry"]},
  {"name": "beef", "quantity": null, "unit": null, "needs_manual_reconciliation": true,
   "entries": [{"quantity": 1, "unit": "lb", "source": "Beef Stew"}, {"quantity": 200, "unit": "ml", "source": "Beef Broth"}]}
]
```

```json
[
  {"name": "salt", "reason": "only vague/to-taste mentions, no quantity found in any recipe", "sources": ["Chicken Stir Fry"]}
]
```

**Resolved:** `parse_recipe` runs per URL, then `build_shopping_list` once
over all of them, before anything is searched. The model never sees raw
per-recipe ingredients — only the merged `shopping_list`, sent to
`/pick-products` (see #3) one batch at a time.

**Resolved:** for a `needs_manual_reconciliation: true` entry, popup.js
searches on `name` alone (no quantity/unit to rank pack-size fit against)
and always routes the decision to the agent rather than the fast path —
same treatment as a substitute (see #3). Kept fully automatic for the
demo — no separate "needs review" step before this point.

Entries in `skipped` (vague-only ingredients like plain "salt to taste")
are informational only — the agent should not search or add anything for
these.

## 2. Search + ranking — owned by the cart team, lives in the browser

An earlier draft of this contract had the agent call a Python
`search_products` tool itself. That's not what happens now: the real
pipeline searches and ranks FairPrice candidates entirely in
`extension/popup.js`:

- `searchFairPrice(query)` hits FairPrice's live search endpoint (the
  site's own search-page payload, not an undocumented product API).
- `rankFairPriceMatches(item, products)` scores every result — name-word
  overlap, a penalty for processed derivatives ("potato" shouldn't match
  "potato starch"), pack-size fit against the quantity needed — and
  returns the ranked shortlist (not just the single best pick, so the
  agent still has options to reason over).
- If the exact ingredient has no in-stock match, `rankWithFallback` (also
  popup.js) automatically broadens the query (drops a trailing "for X"
  clause, then leading descriptive words) and flags the result
  `is_substitute: true`.

The agent (`tools/cart.py`) still carries its own copy of this same search
+ scoring logic (`search_fairprice_raw`, `score_product`,
`search_and_rank_raw`), but only `agent.py`'s standalone CLI demo
(`python agent.py <url>`) uses it — for the *real*, live extension flow,
this is entirely the cart team's code, kept in one place so it can't drift
out of sync as they keep improving it (plural handling, the derivative
penalty, pack-piece counting for things sold by the piece, etc. were all
added after the Python copy was first written).

## 3. `POST /pick-products` — the actual agent contract now

**Implemented** in `server.py`, backed by `agent.py`'s
`choose_product_for_item()`. This is the real boundary between "the cart
team's code" and "the agent": popup.js sends already-ranked candidates for
every shopping-list item in one batch; the agent decides which candidate
(if any) to add and how many, and hands back the raw FairPrice product
object so `background.js` can add it exactly like a client-side pick would
be added.

Request — one entry per shopping-list item:

```json
{
  "items": [
    {
      "name": "chicken breast", "quantity": 500, "unit": "g",
      "needs_manual_reconciliation": false, "is_substitute": false,
      "candidates": [
        {"product": { "...raw FairPrice product, same shape searchFairPrice returns...": null },
         "score": 183.5, "recommended_quantity": 3}
      ]
    }
  ]
}
```

Response:

```json
{
  "picks": [
    {
      "name": "chicken breast",
      "product": { "...raw FairPrice product, or null if skipped...": null },
      "quantity": 3,
      "reason": "clear name/pack-size match, no ambiguity to reason about",
      "decided_by": "rules",
      "is_substitute": false
    }
  ]
}
```

`decided_by` is `"rules"`, `"agent"`, `"search"` (no candidates at all,
even after broadening), or `"error"`. `is_substitute: true` means the
candidates only exist because the exact ingredient was out of stock and
the search was broadened — popup.js shows these separately and requires
an explicit opt-in checkbox before one counts toward "Add to cart."

## 4. Adding to cart — owned by the cart team, also lives in the browser

**Real**, in `extension/background.js` — not a Python tool at all in the
live flow. Given the `product`/`quantity` pairs the person has accepted
(from `/pick-products`, plus any opted-in substitutes), it uses FairPrice's
own native "Add to cart" controls (with a guest-cart fallback), handling
delivery-location prompts, a worker pool for multiple products, and a
progress panel — see the README for the full mechanism.

`tools/cart.py`'s Python `add_to_cart(product_id, quantity)` is still a
stub, used only by `agent.py`'s standalone CLI demo, which has no browser
to add to a real cart with.

## Why the agent only decides, and only sometimes

Search can return several matches at different brands/prices for the same
ingredient — someone needs to reason about which one to pick (closest name
match, right pack size, price) rather than always taking the raw #1 result.
That reasoning is exactly what makes this an *agent* rather than a fixed
script. But calling Bedrock for every single ingredient turned out to be
far too slow under this hackathon account's throttling (one real run: ~80
seconds per call, every call, throttled). So `choose_product_for_item`
only calls the model when the ranking genuinely needs judgment — a real
tie, a weak top score, a flagged substitute, or a
`needs_manual_reconciliation` item; an obvious match is taken directly via
the same ranking the browser already computed, with zero model calls.

## Cost note

In practice this means most ingredients cost zero model calls, and only
the genuinely ambiguous ones (typically a handful per recipe) go to
Bedrock. Those calls still retry through throttling automatically, so a
recipe with several hard ingredients can take a few minutes rather than
seconds — slower than ideal, but far better than calling the model on
every ingredient (which measured at 10+ minutes for one real recipe).
