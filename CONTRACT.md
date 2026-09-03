# Data contract — recipe team ↔ agent ↔ cart team

The agent calls three tools. Everyone builds against these shapes
independently — no need to wait on each other.

## 1. `parse_recipe(url_or_text)` — owned by the recipe team

Called once per recipe. Returns the whole thing, ingredients included.

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
- Open question for the recipe team: what happens with vague lines like
  "salt to taste"? Either return them with `quantity: null` and let the
  agent's instructions decide to skip pantry staples, or drop them
  entirely before returning. Pick one and tell the agent side which.

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
