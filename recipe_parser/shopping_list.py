"""build_shopping_list(recipes): merges parse_recipe() output across several
recipes into one purchase list. Not yet part of CONTRACT.md.
"""
import math

from .units import canonical_unit, to_grams

# Prep/cut/container words stripped when matching ingredient names across
# recipes. Words that mark a different product (fresh, ground, powder,
# dried) stay out of this list on purpose.
STRIP_WORDS = {
    "chopped", "minced", "diced", "sliced", "grated", "smashed",
    "peeled", "crushed", "root", "fine", "thin", "cut", "slice", "of", "piece",
}

# FairPrice sells these by weight (garlic in ~400-500g packs, ginger in
# ~200g packs), not as a discrete bulb or root, so they go through the same
# gram conversion as everything else via COUNT_UNIT_GRAMS/DENSITY_G_PER_ML.
# Chili is kept as an indivisible whole item since it's typically sold by
# the piece, not by weight, and no recipe here has needed one yet to
# verify that assumption against a real product listing.
ALWAYS_BUY_WHOLE = {"chili", "chilies", "chile", "chiles"}

# Assumes one whole item covers this many recipes before buying a second.
RECIPES_PER_WHOLE_ITEM = 3


def _whole_item_quantity(entries):
    return max(1, math.ceil(len(entries) / RECIPES_PER_WHOLE_ITEM))

# Recipe wording uses cut names that don't match how FairPrice lists
# products (e.g. "round steak" is US butchery terminology). Override to
# the generic term that's actually worth searching for. The full recipe
# wording is still kept in raw_text for the agent to disambiguate with.
NAME_OVERRIDES = {"beef round steak": "beef"}


def _canonical_name(name):
    words = [w for w in name.lower().replace(",", " ").split() if w not in STRIP_WORDS]
    canonical = " ".join(words) or name.lower()
    return NAME_OVERRIDES.get(canonical, canonical)


def _line(name, quantity, unit, sources):
    return {"name": name, "quantity": quantity, "unit": unit, "sources": sources}


def build_shopping_list(recipes):
    """recipes: list of parse_recipe() output dicts.

    Returns (shopping_list, skipped). shopping_list has one entry per
    consolidated ingredient: grams where that's meaningful, a shared native
    unit (e.g. "clove") when grams doesn't apply, or flagged as
    needs_manual_reconciliation when neither works. skipped lists "to
    taste" mentions that were dropped, with why.
    """
    groups = {}
    for recipe in recipes:
        for ingredient in recipe["ingredients"]:
            key = _canonical_name(ingredient["name"])
            groups.setdefault(key, []).append((recipe["title"], ingredient))

    shopping_list = []
    skipped = []

    for key, entries in groups.items():
        real = [(title, ing) for title, ing in entries if ing["quantity"] is not None]
        vague = [(title, ing) for title, ing in entries if ing["quantity"] is None]

        if not real:
            skipped.append({
                "name": key,
                "reason": "only vague/to-taste mentions, no quantity found in any recipe",
                "sources": [title for title, _ in vague],
            })
            continue

        real_titles = [title for title, _ in real]

        if key in ALWAYS_BUY_WHOLE:
            quantity = _whole_item_quantity(entries)
            shopping_list.append(_line(key, quantity, "whole", [title for title, _ in entries]))
            continue

        grams = [to_grams(ing["quantity"], ing["unit"], key) for _, ing in real]
        if all(g is not None for g in grams):
            shopping_list.append(_line(key, round(sum(grams), 1), "g", real_titles))
        elif len(real) == 1:
            # A single mention has nothing to reconcile against, so pass
            # it through as-is even if the unit is a bare count.
            _, ing = real[0]
            quantity = ing["quantity"]
            quantity = round(quantity, 3) if isinstance(quantity, float) else quantity
            unit = canonical_unit(ing["unit"]) or ing["unit"]
            shopping_list.append(_line(key, quantity, unit, real_titles))
        else:
            units_used = {canonical_unit(ing["unit"]) for _, ing in real}
            if len(units_used) == 1 and None not in units_used:
                unit = units_used.pop()
                total = round(sum(ing["quantity"] for _, ing in real), 3)
                shopping_list.append(_line(key, total, unit, real_titles))
            else:
                shopping_list.append({
                    "name": key,
                    "needs_manual_reconciliation": True,
                    "entries": [
                        {"quantity": ing["quantity"], "unit": ing["unit"], "source": title}
                        for title, ing in real
                    ],
                })

        if vague:
            skipped.append({
                "name": key,
                "reason": "to-taste mention already covered by a quantified entry elsewhere",
                "sources": [title for title, _ in vague],
            })

    return shopping_list, skipped
