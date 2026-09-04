"""parse_recipe(url_or_text). See CONTRACT.md #1 for the output shape.

Scoped to allrecipes.com. Extracts the schema.org/Recipe JSON-LD block
AllRecipes embeds on every page, rather than scraping rendered HTML.
"""
import json
import re

import requests

from .units import UNIT_ALIASES

JSONLD_RE = re.compile(
    r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
    re.DOTALL,
)

FRACTIONS = {
    "¼": 0.25, "½": 0.5, "¾": 0.75,
    "⅓": 1 / 3, "⅔": 2 / 3,
    "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
}
FRACTION_CHARS = "".join(FRACTIONS)

EXCLUDED_NAMES = {"water"}

CONTAINER_WORDS = {"can", "cans", "jar", "jars", "bag", "bags", "package", "packages", "box", "boxes"}

_LEADING_NUM_RE = re.compile(rf"^[\d{FRACTION_CHARS}/.\s]+")
_PAREN_RE = re.compile(r"\((?P<inner>[^)]*\d[^)]*)\)")
_PAREN_INNER_RE = re.compile(r"\s*([\d./\s]+)\s*([a-zA-Z]+)")

# A parenthetical this close to the start of the line is a size attached to
# the leading quantity, e.g. "1 (8 ounce) can". One further away, e.g.
# "Asian (toasted) sesame oil", is just a descriptive aside.
_LEADING_PAREN_CUTOFF = 6


_GLUED_FRACTION_RE = re.compile(rf"(\d)([{FRACTION_CHARS}])")


def _parse_number(text):
    """'1 1/2', '1½', '1/2', '¾', '8' to float. None if nothing numeric found."""
    text = _GLUED_FRACTION_RE.sub(r"\1 \2", text)
    total, found = 0.0, False
    for token in text.replace("(", " ").replace(")", " ").split():
        if token in FRACTIONS:
            total += FRACTIONS[token]
            found = True
        elif "/" in token and all(p.strip().isdigit() for p in token.split("/", 1)):
            num, den = token.split("/", 1)
            total += int(num) / int(den)
            found = True
        elif token.replace(".", "", 1).isdigit():
            total += float(token)
            found = True
    return total if found else None


def _split_line(raw_text):
    """One recipeIngredient string to (name, quantity, unit)."""
    text = raw_text.strip()

    if not re.match(rf"^[\d{FRACTION_CHARS}]", text):
        # e.g. "Salt and pepper to taste", no quantity at all.
        name = re.sub(r",?\s*to taste\.?$", "", text, flags=re.I).strip()
        return name, None, None

    paren = _PAREN_RE.search(text)
    if paren and text.index(paren.group(0)) < _LEADING_PAREN_CUTOFF:
        # "1 (8 ounce) can pineapple chunks": the parenthetical size is the
        # useful quantity, the outer "1" just means one can.
        inner_match = _PAREN_INNER_RE.match(paren.group("inner"))
        if inner_match:
            quantity = _parse_number(inner_match.group(1))
            unit = inner_match.group(2).lower()
        else:
            quantity = _parse_number(paren.group("inner"))
            unit = None
        rest = text[paren.end():].strip(" ,")
        leading_word = re.match(r"([a-zA-Z]+)\b", rest)
        if leading_word and leading_word.group(1).lower() in CONTAINER_WORDS:
            rest = rest[leading_word.end():].strip(" ,")
    else:
        num_match = _LEADING_NUM_RE.match(text)
        quantity = _parse_number(num_match.group(0)) if num_match else None
        remainder = text[num_match.end():].strip() if num_match else text
        unit = None
        rest = remainder
        # Check a few leading words, not just the first: "thin slice of
        # ginger" needs to skip past "thin" to find "slice".
        for word_match in list(re.finditer(r"[a-zA-Z]+", remainder))[:3]:
            if word_match.group(0).lower() in UNIT_ALIASES:
                unit = word_match.group(0).lower()
                rest = remainder[word_match.end():].strip(" ,")
                break

    # Any parens left at this point are a descriptive aside, not quantity
    # info, but the words inside can still distinguish the product (e.g.
    # "(toasted)" sesame oil), so unwrap them instead of discarding them.
    rest = rest.replace("(", " ").replace(")", " ")
    rest = re.sub(r"\s+", " ", rest).strip(" ,")

    name = rest.split(",")[0].strip()
    return (name or text), quantity, unit


def parse_recipe(url_or_text):
    """See CONTRACT.md #1 for the exact output shape."""
    if url_or_text.startswith("http"):
        # A bare "User-Agent: Mozilla/5.0" gets 403'd. Needs a header set
        # that looks like an actual browser request.
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        response = requests.get(url_or_text, timeout=10, headers=headers)
        response.raise_for_status()
        html = response.text
    else:
        html = url_or_text

    recipe = None
    for block in JSONLD_RE.findall(html):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else data.get("@graph", [data])
        for item in candidates:
            types = item.get("@type")
            types = types if isinstance(types, list) else [types]
            if "Recipe" in types:
                recipe = item
                break
        if recipe:
            break

    if recipe is None:
        raise ValueError(f"No Recipe JSON-LD found at {url_or_text}")

    ingredients = []
    for raw_line in recipe.get("recipeIngredient", []):
        name, quantity, unit = _split_line(raw_line)
        if name.strip().lower() in EXCLUDED_NAMES:
            continue
        ingredients.append(
            {"name": name, "quantity": quantity, "unit": unit, "raw_text": raw_line}
        )

    servings = None
    yield_text = recipe.get("recipeYield")
    if yield_text:
        match = re.search(r"\d+", str(yield_text))
        servings = int(match.group()) if match else None

    return {
        "title": recipe.get("name", "").strip(),
        "servings": servings,
        "ingredients": ingredients,
    }
