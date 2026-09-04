"""Checks for build_shopping_list(), using ingredient data hand-transcribed
from the 3 prototype recipes so this test doesn't need the network. Run:

    python tests/test_shopping_list.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recipe_parser.shopping_list import build_shopping_list


def _ing(name, quantity, unit, raw_text):
    return {"name": name, "quantity": quantity, "unit": unit, "raw_text": raw_text}


HAWAIIAN_MEATBALLS = {
    "title": "Hawaiian Meatballs",
    "servings": 4,
    "ingredients": [
        _ing("ground beef", 1, "lb", "1 pound ground beef"),
        _ing("ground ginger", 0.5, "tsp", "½ teaspoon ground ginger"),
        _ing("garlic powder", 0.25, "tsp", "¼ teaspoon garlic powder"),
        _ing("ground black pepper", 0.25, "tsp", "¼ teaspoon ground black pepper"),
        _ing("pineapple chunks", 8, "oz", "1 (8 ounce) can pineapple chunks, juice reserved"),
        _ing("brown sugar", 0.25, "cup", "¼ cup brown sugar"),
        _ing("cornstarch", 2, "tbsp", "2 tablespoons cornstarch"),
        _ing("white vinegar", 0.25, "cup", "¼ cup white vinegar"),
        _ing("soy sauce", 1, "tbsp", "1 tablespoon soy sauce"),
        _ing("green bell pepper", 1, "whole", "1 green bell pepper, chopped"),
        # "water" is absent here; parse_recipe drops it before this point.
    ],
}

TERIYAKI_CHICKEN = {
    "title": "Teriyaki Roasted Chicken",
    "servings": 6,
    "ingredients": [
        _ing("whole chicken", 3, "lb", "1 (3 pound) whole chicken, cut in half"),
        _ing("granulated sugar", 0.75, "cup", "¾ cup granulated sugar"),
        _ing("soy sauce", 0.75, "cup", "¾ cup soy sauce"),
        _ing("fresh ginger", 1, "tbsp", "1 tablespoon grated fresh ginger"),
        _ing("garlic", 2, "cloves", "2 cloves garlic, minced"),
    ],
}

BEEF_AND_BROCCOLI = {
    "title": "Restaurant-Style Beef and Broccoli",
    "servings": 4,
    "ingredients": [
        _ing("oyster sauce", 1 / 3, "cup", "⅓ cup oyster sauce"),
        _ing("soy sauce", 1, "tsp", "1 teaspoon soy sauce"),
        _ing("white sugar", 1, "tsp", "1 teaspoon white sugar"),
        _ing("cornstarch", 1, "tsp", "1 teaspoon cornstarch"),
        _ing("beef round steak", 0.75, "lb", "¾ pound beef round steak, cut into strips"),
        _ing("of fresh ginger root", 1, "slice", "1 thin slice of fresh ginger root"),
        _ing("garlic", 1, "clove", "1 clove garlic, peeled and smashed"),
        _ing("broccoli", 1, "lb", "1 pound broccoli, cut into florets"),
    ],
}


def test_soy_sauce_merges_across_all_three_recipes():
    shopping_list, _ = build_shopping_list(
        [HAWAIIAN_MEATBALLS, TERIYAKI_CHICKEN, BEEF_AND_BROCCOLI]
    )
    soy = next(item for item in shopping_list if item["name"] == "soy sauce")
    assert soy["unit"] == "g"
    assert len(soy["sources"]) == 3
    # 1 tbsp + 3/4 cup + 1 tsp at 1.10 g/ml lands around 217g.
    assert 210 < soy["quantity"] < 225


def test_cornstarch_merges_across_two_recipes():
    shopping_list, _ = build_shopping_list([HAWAIIAN_MEATBALLS, BEEF_AND_BROCCOLI])
    cornstarch = next(item for item in shopping_list if item["name"] == "cornstarch")
    assert cornstarch["unit"] == "g"
    assert len(cornstarch["sources"]) == 2


def test_garlic_cloves_convert_to_grams():
    # FairPrice sells garlic by weight, not the piece: 2 cloves + 1 clove
    # at ~3g/clove should land around 9g.
    shopping_list, _ = build_shopping_list([TERIYAKI_CHICKEN, BEEF_AND_BROCCOLI])
    garlic = next(item for item in shopping_list if item["name"] == "garlic")
    assert garlic["unit"] == "g"
    assert 8 < garlic["quantity"] < 10
    assert len(garlic["sources"]) == 2


def test_recipe_specific_cut_names_become_generic_search_terms():
    # "beef round steak" is US butchery terminology that won't match how
    # FairPrice lists products; the LLM downstream needs a generic term.
    shopping_list, _ = build_shopping_list([BEEF_AND_BROCCOLI])
    names = {item["name"] for item in shopping_list}
    assert "beef" in names
    assert "beef round steak" not in names


def test_whole_item_quantity_scales_up_with_demand():
    # chili is bought by the piece, not by weight, so it stays a whole-item
    # purchase. 7 recipes needing it should buy more than a single chili.
    heavy_chili_recipes = [
        {
            "title": f"Recipe {i}",
            "servings": 2,
            "ingredients": [_ing("chili", 1, None, "1 red chili, sliced")],
        }
        for i in range(7)
    ]
    shopping_list, _ = build_shopping_list(heavy_chili_recipes)
    chili = next(item for item in shopping_list if item["name"] == "chili")
    assert chili["unit"] == "whole"
    assert chili["quantity"] > 1


def test_sugars_do_not_merge_across_different_products():
    shopping_list, _ = build_shopping_list(
        [HAWAIIAN_MEATBALLS, TERIYAKI_CHICKEN, BEEF_AND_BROCCOLI]
    )
    names = {item["name"] for item in shopping_list}
    assert "brown sugar" in names
    assert "granulated sugar" in names
    assert "white sugar" in names
    assert "sugar" not in names  # not merged into one generic line


def test_ground_ginger_and_fresh_ginger_stay_separate():
    shopping_list, _ = build_shopping_list([HAWAIIAN_MEATBALLS, TERIYAKI_CHICKEN, BEEF_AND_BROCCOLI])
    by_name = {item["name"]: item for item in shopping_list}
    assert "ground ginger" in by_name  # Hawaiian Meatballs only, a different product
    assert by_name["ground ginger"]["unit"] == "tsp"


def test_fresh_ginger_tbsp_and_slice_both_convert_to_grams():
    # Teriyaki calls for "1 tbsp grated" (~6g), Beef and Broccoli for "1
    # slice" (~2.5g). Different units, but both convert to grams so they
    # can actually be summed instead of being flagged unreconcilable.
    shopping_list, _ = build_shopping_list([TERIYAKI_CHICKEN, BEEF_AND_BROCCOLI])
    ginger = next(item for item in shopping_list if item["name"] == "fresh ginger")
    assert "needs_manual_reconciliation" not in ginger
    assert ginger["unit"] == "g"
    assert 8 < ginger["quantity"] < 9
    assert len(ginger["sources"]) == 2


def test_vague_quantity_is_dropped_when_already_covered():
    recipe_a = {
        "title": "Recipe A",
        "servings": 2,
        "ingredients": [_ing("salt", 1, "tsp", "1 teaspoon salt")],
    }
    recipe_b = {
        "title": "Recipe B",
        "servings": 2,
        "ingredients": [_ing("salt", None, None, "Salt, to taste")],
    }
    shopping_list, skipped = build_shopping_list([recipe_a, recipe_b])
    salt_entries = [item for item in shopping_list if item["name"] == "salt"]
    assert len(salt_entries) == 1  # only Recipe A's real quantity, not doubled
    assert any(s["name"] == "salt" and "Recipe B" in s["sources"] for s in skipped)


def test_vague_quantity_with_no_real_quantity_anywhere_is_skipped():
    recipe_a = {
        "title": "Recipe A",
        "servings": 2,
        "ingredients": [_ing("salt", None, None, "Salt, to taste")],
    }
    shopping_list, skipped = build_shopping_list([recipe_a])
    assert not any(item["name"] == "salt" for item in shopping_list)
    assert any(s["name"] == "salt" for s in skipped)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS: {name}")
