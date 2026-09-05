# Data contract — recipe team ↔ agent ↔ cart team

The agent calls tools. Everyone builds against these shapes
independently — no need to wait on each other.

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

**Resolved:** `agent.py` calls `parse_recipe` per URL, then
`build_shopping_list` once over all of them, *before* the tool loop starts.
The model never sees raw per-recipe ingredients — only the merged
`shopping_list`, one entry at a time, via `search_products`/`add_to_cart`.

**Resolved:** for a `needs_manual_reconciliation: true` entry, the agent
calls `search_products` on `name` alone (no quantity/unit to work with) and
lets the model pick a reasonable pack size from whatever candidates come
back, same as any other item. Kept fully automatic for the demo — no
separate "needs review" path in the agent loop.

Entries in `skipped` (vague-only ingredients like plain "salt to taste")
are informational only — the agent should not search or add anything for
these.

## 2. `search_products(query)` — owned by the cart team

Called once per ingredient. Returns a short ranked list, not the whole
catalog — 3-5 candidates is plenty; more just costs the agent more to read
(and more model calls we can't always avoid, see below).

```json
[
  {"product_id": "P123", "name": "FairPrice Chicken Breast", "brand": "FairPrice", "price": 5.90, "pack_size": "500g"},
  {"product_id": "P456", "name": "Ayam Brand Chicken Breast", "brand": "Ayam Brand", "price": 7.20, "pack_size": "500g"}
]
```

Return `[]` if nothing matches — the agent needs to be able to tell "no
results" apart from "results, but none of them look right."

## 3. `add_to_cart(product_id, quantity)` — owned by the cart team

Called once the agent has picked a specific product from `search_products`.

```json
{"status": "added", "product_id": "P123", "quantity": 1, "price": 5.90}
```
or on failure:
```json
{"status": "failed", "product_id": "P123", "reason": "out of stock"}
```

## Why search and add are separate tools

`search_products` can return several matches at different brands/prices for
the same ingredient. The agent needs to see those options and reason about
which one to pick (closest name match, right pack size for the quantity
needed, price) before committing — that reasoning step is exactly what
makes this an *agent* rather than a fixed script. So: search first, model
decides, then add by exact `product_id`.

## Cost note

This means roughly two model calls per ingredient (search, then add)
instead of one. Combined with this AWS sandbox account's tight rate
limiting (see Step 1), a recipe with many ingredients will take noticeably
longer to run live than you might expect. The agent code already retries
through throttling automatically — it just means "slower," not "broken."
