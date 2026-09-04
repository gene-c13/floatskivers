"""Plain-assert checks for to_grams(). Run: python tests/test_units.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recipe_parser.units import to_grams, canonical_unit


def test_mass_units_convert_directly():
    assert to_grams(1, "pound", "ground beef") == 453.592
    assert to_grams(500, "g", "ground beef") == 500


def test_volume_needs_density():
    assert to_grams(1, "tbsp", "soy sauce") == round(14.7868 * 1.10, 10)
    assert to_grams(1, "tbsp", "an ingredient with no density entry") is None


def test_count_units_without_a_known_weight_dont_convert():
    assert to_grams(1, "can", "pineapple chunks") is None
    assert to_grams(2, "cloves", "an ingredient with no clove weight on file") is None


def test_count_units_with_a_known_weight_convert():
    assert to_grams(2, "cloves", "garlic") == 6.0
    assert to_grams(1, "slice", "fresh ginger") == 2.5


def test_missing_quantity_or_unit():
    assert to_grams(None, "cup", "sugar") is None
    assert to_grams(1, None, "sugar") is None


def test_canonical_unit_aliases():
    assert canonical_unit("Tablespoons") == "tbsp"
    assert canonical_unit("cloves") == "clove"
    assert canonical_unit("typo-unit") is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS: {name}")
