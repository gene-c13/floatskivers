"""search_products / add_to_cart — stubbed until the cart team's real
FairPrice integration lands. Keep the return shapes here matching
CONTRACT.md #2 and #3 exactly; agent.py should need zero changes when these
get swapped for the real thing.
"""


def _fake_price(seed: str, low: float, high: float) -> float:
    """Deterministic fake price so demo runs are reproducible."""
    h = sum(ord(c) for c in seed)
    return round(low + (h % 100) / 100 * (high - low), 2)


def search_products(query: str) -> list:
    print(f"      [tool] search_products({query!r})")
    base = query.strip().title()
    slug = "".join(c for c in query.upper() if c.isalnum())[:3] or "XXX"
    return [
        {
            "product_id": f"STUB-{slug}-1",
            "name": f"FairPrice {base}",
            "brand": "FairPrice",
            "price": _fake_price(query + "1", 2.0, 8.0),
            "pack_size": "500g",
        },
        {
            "product_id": f"STUB-{slug}-2",
            "name": f"{base} (Ayam Brand)",
            "brand": "Ayam Brand",
            "price": _fake_price(query + "2", 3.0, 10.0),
            "pack_size": "400g",
        },
    ]


def add_to_cart(product_id: str, quantity: int) -> dict:
    print(f"      [tool] add_to_cart({product_id!r}, {quantity!r})")
    return {
        "status": "added",
        "product_id": product_id,
        "quantity": quantity,
        "price": _fake_price(product_id, 2.0, 10.0),
    }
