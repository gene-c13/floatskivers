"""Unit conversion helpers for the recipe ingredient pipeline."""

# Every unit spelling we've seen, mapped to one short form. Unknown units
# map to None instead of guessing.
UNIT_ALIASES = {
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
    "tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp",
    "cup": "cup", "cups": "cup",
    "g": "g", "gram": "g", "grams": "g",
    "kg": "kg", "kilogram": "kg", "kilograms": "kg",
    "oz": "oz", "ounce": "oz", "ounces": "oz",
    "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "clove": "clove", "cloves": "clove",
    "can": "can", "cans": "can",
    "slice": "slice", "slices": "slice",
    "pinch": "pinch", "pinches": "pinch",
    "whole": "whole",
}

VOLUME_TO_ML = {"tsp": 4.92892, "tbsp": 14.7868, "cup": 236.588}
MASS_TO_G = {"g": 1.0, "kg": 1000.0, "oz": 28.3495, "lb": 453.592}

# Grams per ml. Only covers ingredients that currently need summing.
# Missing an entry just means to_grams() returns None for it.
DENSITY_G_PER_ML = {
    "soy sauce": 1.10,
    "cornstarch": 0.60,
    "white vinegar": 1.01,
    "vegetable oil": 0.92,
    "sesame oil": 0.92,
    "oyster sauce": 1.15,
    "white sugar": 0.85,
    "granulated sugar": 0.85,
    "brown sugar": 0.93,
    "fresh ginger": 6.06 / 14.7868,  # 1 tbsp grated ginger is about 6g
}

# Grams for one unit of a count-based measurement (clove, slice, ...),
# keyed by (ingredient name, unit). FairPrice sells garlic and ginger by
# weight, not by the piece, so these let a "2 cloves" or "1 slice" mention
# convert to grams instead of being treated as an indivisible whole item.
COUNT_UNIT_GRAMS = {
    ("garlic", "clove"): 3.0,
    ("fresh ginger", "slice"): 2.5,
}


def canonical_unit(unit):
    if unit is None:
        return None
    return UNIT_ALIASES.get(unit.strip().lower())


def to_grams(quantity, unit, ingredient_name):
    """Convert quantity/unit to grams for the named ingredient, or None."""
    if quantity is None or unit is None:
        return None

    unit = canonical_unit(unit)
    if unit is None:
        return None

    name = ingredient_name.strip().lower()

    if unit in MASS_TO_G:
        return quantity * MASS_TO_G[unit]

    if unit in VOLUME_TO_ML:
        density = DENSITY_G_PER_ML.get(name)
        if density is None:
            return None
        return quantity * VOLUME_TO_ML[unit] * density

    per_unit = COUNT_UNIT_GRAMS.get((name, unit))
    if per_unit is not None:
        return quantity * per_unit

    return None
