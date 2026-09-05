import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai_product_selector import select_product


PRODUCTS = [
    {"id": "light", "name": "Light Soy Sauce 500ml"},
    {"id": "dark", "name": "Dark Soy Sauce 500ml"},
]


def fallback(products):
    return products[0]


def test_ai_selects_exact_context_match():
    result = select_product({"ingredient": {"name": "light soy sauce"}}, PRODUCTS, fallback, lambda _: {"selected_product_id": "light", "reason": "Exact type match", "confidence": 0.98})
    assert result["product"]["id"] == "light"


def test_recipe_context_prefers_reduced_sodium_variant():
    products = [{"id": "regular", "name": "Soy Sauce 500ml"}, {"id": "less", "name": "Less Salt Soy Sauce 500ml"}]
    result = select_product({"recipe_name": "Low Sodium Teriyaki", "ingredient": {"name": "soy sauce"}}, products, fallback, lambda _: {"selected_product_id": "less", "reason": "Recipe context requests lower sodium", "confidence": 0.9})
    assert result["product"]["id"] == "less"


def test_specific_type_rejects_wrong_variant():
    products = [{"id": "light", "name": "Light Soy Sauce"}, {"id": "dark", "name": "Dark Soy Sauce"}]
    result = select_product({"ingredient": {"name": "light soy sauce"}}, products, fallback, lambda _: {"selected_product_id": "light", "reason": "Matches required type", "confidence": 0.95})
    assert result["product"]["name"] == "Light Soy Sauce"


def test_inappropriate_ai_choice_is_rejected():
    result = select_product({"ingredient": {"name": "soy sauce"}}, PRODUCTS, fallback, lambda _: {"selected_product_id": "dark", "reason": "wrong type", "confidence": 0.2})
    assert result["product"]["id"] == "light"
    assert result["source"] == "fallback"


def test_ai_failure_uses_deterministic_fallback():
    result = select_product({}, PRODUCTS, fallback, lambda _: (_ for _ in ()).throw(RuntimeError()))
    assert result["product"]["id"] == "light"
    assert result["source"] == "fallback"


def test_invalid_id_uses_fallback():
    result = select_product({}, PRODUCTS, fallback, lambda _: {"selected_product_id": "missing", "reason": "bad", "confidence": 1})
    assert result["product"]["id"] == "light"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS: {name}")
