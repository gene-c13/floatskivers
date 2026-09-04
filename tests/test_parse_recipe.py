"""Checks for _split_line() and _parse_number(), the regex-based ingredient
line parser. No network needed. Run: python tests/test_parse_recipe.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recipe_parser.parse_recipe import _parse_number, _split_line


def test_plain_decimal_quantity():
    # This is the actual format AllRecipes' JSON-LD uses.
    assert _split_line("0.5 teaspoon ground ginger") == ("ground ginger", 0.5, "tsp") \
        or _split_line("0.5 teaspoon ground ginger") == ("ground ginger", 0.5, "teaspoon")


def test_mixed_number():
    assert _parse_number("1 1/2") == 1.5


def test_spaced_unicode_fraction():
    assert _parse_number("1 ½") == 1.5


def test_glued_unicode_fraction():
    # A very common recipe-site style: no space between the whole number
    # and the fraction glyph.
    assert _parse_number("1½") == 1.5
    name, quantity, unit = _split_line("1½ cups all-purpose flour")
    assert quantity == 1.5
    assert unit == "cups"
    assert name == "all-purpose flour"


def test_size_in_parens_is_the_real_quantity():
    name, quantity, unit = _split_line("1 (8 ounce) can pineapple chunks, juice reserved")
    assert name == "pineapple chunks"
    assert quantity == 8.0
    assert unit == "ounce"


def test_descriptive_paren_is_unwrapped_not_deleted():
    # "toasted" distinguishes a different product from plain sesame oil,
    # so it should survive even though it's in parens.
    name, quantity, unit = _split_line("2 teaspoons Asian (toasted) sesame oil")
    assert "toasted" in name
    assert quantity == 2.0


def test_vague_line_has_no_quantity_or_unit():
    name, quantity, unit = _split_line("Salt and pepper, to taste")
    assert quantity is None
    assert unit is None
    assert "taste" not in name.lower()


def test_bare_count_with_no_unit():
    name, quantity, unit = _split_line("1 green bell pepper, chopped")
    assert name == "green bell pepper"
    assert quantity == 1.0
    assert unit is None


if __name__ == "__main__":
    for test_name, fn in list(globals().items()):
        if test_name.startswith("test_"):
            fn()
            print(f"PASS: {test_name}")
