"""The real agent: parses recipes, merges them into one shopping list, then
runs a tool-calling loop against Bedrock so the model can search and add
each item to the FairPrice cart. See CONTRACT.md for every shape below.

parse_recipe / build_shopping_list are real (recipe_parser/, Hong Ting).
search_products / add_to_cart are stubbed in tools/cart.py until the cart
team's code lands — swapping them in later shouldn't require touching this
file, since agent.py only ever sees CONTRACT.md's shapes.

    python agent.py <recipe_url> [<recipe_url> ...]
"""

import json
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ConnectTimeoutError, ReadTimeoutError
from dotenv import load_dotenv

from recipe_parser import build_shopping_list, parse_recipe
from tools.cart import add_to_cart, recommended_pack_count, search_and_rank_raw, search_products

load_dotenv()

MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"
STEPS_PER_ITEM = 4  # search + add + a little slack, per shopping-list item
MIN_STEPS = 10

# Explicit timeouts, and botocore's own retries turned off — without this,
# a stalled Bedrock response hangs the whole client forever instead of
# raising, so our own retry-with-backoff loop below never gets a chance to
# run. Found by watching a real run sit on one open connection for 30+
# minutes with a client that had no timeout configured at all.
client = boto3.Session().client(
    "bedrock-runtime",
    region_name="ap-southeast-1",
    config=Config(connect_timeout=10, read_timeout=30, retries={"max_attempts": 0}),
)

REGISTRY = {"search_products": search_products, "add_to_cart": add_to_cart}

TOOL_SPECS = [
    {
        "name": "search_products",
        "description": (
            "Search the real FairPrice catalog for one grocery item. Returns "
            "a short ranked list of candidate products with brand, price, "
            "and pack size — the ranking already favors closer name matches "
            "and, when quantity/unit are given, better-fitting pack sizes, "
            "but you still choose which one to add. Pass quantity and unit "
            "from the shopping-list entry when you have them (e.g. 500, "
            "'g') for a better ranking; omit them for vague items."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "quantity": {"type": "number"},
                "unit": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "add_to_cart",
        "description": (
            "Add one specific product, by its exact product_id from a prior "
            "search_products call, to the FairPrice cart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "product_id": {"type": "string"},
                "quantity": {"type": "integer"},
            },
            "required": ["product_id", "quantity"],
        },
    },
]


def call_model(messages: list, tools: list = None, tool_choice: dict = None, max_retries: int = 6) -> dict:
    """One model turn, retrying through throttling with growing waits."""
    body_dict = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "tools": TOOL_SPECS if tools is None else tools,
        "messages": messages,
    }
    if tool_choice is not None:
        body_dict["tool_choice"] = tool_choice
    body = json.dumps(body_dict)
    wait = 5
    for attempt in range(1, max_retries + 1):
        try:
            response = client.invoke_model(modelId=MODEL_ID, body=body)
            return json.loads(response["body"].read())
        except (client.exceptions.ThrottlingException, ReadTimeoutError, ConnectTimeoutError) as exc:
            if attempt == max_retries:
                raise
            print(
                f"      [{type(exc).__name__} — waiting {wait}s, attempt {attempt}/{max_retries}]",
                flush=True,
            )
            time.sleep(wait)
            wait = min(wait * 2, 60)


def run_tool(block: dict) -> dict:
    fn = REGISTRY[block["name"]]
    result = fn(**block["input"])
    return {
        "type": "tool_result",
        "tool_use_id": block["id"],
        "content": [{"type": "text", "text": json.dumps(result)}],
    }


def build_goal(shopping_list: list, skipped: list) -> str:
    lines = [
        "Add these items to the FairPrice cart. For each one:",
        "1. Call search_products with a short, product-searchable query — "
        "pass the item's quantity and unit too when the list below gives you "
        "one, so results are ranked by pack-size fit as well as name match.",
        "2. Look at the candidates and pick the closest match — consider "
        "name, pack size vs. the quantity needed, and price.",
        "3. Call add_to_cart with that product's exact product_id.",
        "4. If search_products returns no results, skip that item and say "
        "so in your summary.",
        "",
        "Shopping list:",
    ]
    for item in shopping_list:
        if item.get("needs_manual_reconciliation"):
            lines.append(f"- {item['name']} (quantity unclear across recipes — use your judgement)")
        else:
            lines.append(f"- {item['name']}: {item['quantity']} {item['unit']}")

    if skipped:
        lines.append("")
        lines.append("Not on the list (vague/pantry mentions, already skipped upstream):")
        for s in skipped:
            lines.append(f"- {s['name']}")

    lines.append("")
    lines.append("When everything is done, give a short plain-English summary of what was added.")
    return "\n".join(lines)


PICK_TOOL_SPEC = {
    "name": "choose_product",
    "description": (
        "Choose which FairPrice product (if any) to buy for this "
        "ingredient, and how many packs/units of it to buy."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "product_id": {
                "type": "string",
                "description": "Exact product_id of the chosen candidate. Omit if skip is true.",
            },
            "quantity": {
                "type": "integer",
                "description": "How many packs/units to add to the cart.",
            },
            "skip": {
                "type": "boolean",
                "description": "True if none of the candidates are a reasonable match.",
            },
            "reason": {
                "type": "string",
                "description": "One short sentence explaining the choice or skip.",
            },
        },
        "required": [],
    },
}


# How much clearer the top candidate needs to be than the runner-up before
# we trust the deterministic ranking and skip the Bedrock call entirely.
# Thresholds are on score_product's scale (a single matching word is worth
# 100) — chosen to catch the obvious cases (exact/near-exact name match,
# nothing else close) while sending anything with a real tie, a weak match,
# or no runner-up-beating margin to the model instead. Tuned by eyeballing
# real FairPrice search results, not derived from first principles.
_CONFIDENT_MIN_SCORE = 100
_CONFIDENT_MIN_GAP = 50


def choose_product_for_item(item: dict) -> dict:
    """Search FairPrice for one shopping-list item and pick a candidate (if
    any) to add, and how many.

    Used by server.py's /pick-products endpoint, which extension/popup.js
    calls instead of doing its own scoreProduct/chooseBestProduct ranking
    in JS. The actual add-to-cart step still happens in the browser via
    background.js, since that needs a real FairPrice tab — this only
    decides *what* to add.

    Most items have an obvious best match, so this only calls Bedrock when
    the deterministic ranking (same scoring as extension/popup.js) isn't
    decisive — a real tie, a weak top score, or an ingredient already
    flagged as needing manual reconciliation. Calling the model on every
    single item, one at a time, turned out to be far too slow under this
    account's Bedrock throttling for a real recipe's worth of ingredients;
    reserving it for genuinely ambiguous cases keeps most items fast while
    still giving the model's judgment somewhere to matter.

    When the exact ingredient has no viable (in-stock) match, search_and_
    rank_raw already broadened the search for us (see its docstring) — in
    that case this always goes through the model, never the fast path,
    and the result comes back flagged is_substitute: true so the caller
    can ask before treating it like a normal match (see extension/popup.js,
    which shows these separately and requires an explicit opt-in before
    adding one to the cart).

    Returns {"name", "product", "quantity", "reason", "decided_by",
    "is_substitute"} — "product" is the raw FairPrice object (or None if
    skipped/no match), ready to hand straight to background.js the same
    way a client-side pick would be. "decided_by" is "rules" or "agent".
    """
    quantity_hint = None if item.get("needs_manual_reconciliation") else item.get("quantity")
    unit_hint = None if item.get("needs_manual_reconciliation") else item.get("unit")

    candidates, raw_by_id, scores, is_substitute = search_and_rank_raw(
        item["name"], quantity_hint, unit_hint, limit=8
    )
    if not candidates:
        return {
            "name": item["name"],
            "product": None,
            "quantity": 0,
            "reason": "no FairPrice matches found, even after broadening the search",
            "decided_by": "search",
            "is_substitute": False,
        }

    is_hard_case = is_substitute or bool(item.get("needs_manual_reconciliation"))
    if not is_hard_case:
        top_score = scores[0]
        runner_up = scores[1] if len(scores) > 1 else float("-inf")
        is_hard_case = not (top_score >= _CONFIDENT_MIN_SCORE and (top_score - runner_up) >= _CONFIDENT_MIN_GAP)

    if not is_hard_case:
        top = candidates[0]
        return {
            "name": item["name"],
            "product": raw_by_id.get(top["product_id"]),
            "quantity": recommended_pack_count(quantity_hint, unit_hint, top),
            "reason": "clear name/pack-size match, no ambiguity to reason about",
            "decided_by": "rules",
            "is_substitute": False,
        }

    substitute_note = (
        f"\n\nNote: \"{item['name']}\" itself had no in-stock match on FairPrice, "
        "so these candidates come from a broader search and are substitutes, "
        "not the exact ingredient. Only choose one if it's a genuinely "
        "reasonable stand-in; otherwise skip."
        if is_substitute
        else ""
    )
    prompt = (
        f"Ingredient needed: {item['name']}"
        + (f", {quantity_hint} {unit_hint}" if quantity_hint else " (quantity unclear)")
        + substitute_note
        + "\n\nCandidates from FairPrice, best-ranked first:\n"
        + json.dumps(candidates, indent=2)
        + "\n\nCall choose_product with the best match's product_id and how "
        "many packs to buy, or set skip: true if none of these are a "
        "reasonable match for this ingredient."
    )
    reply = call_model(
        [{"role": "user", "content": prompt}],
        tools=[PICK_TOOL_SPEC],
        tool_choice={"type": "tool", "name": "choose_product"},
    )

    tool_use = next((b for b in reply["content"] if b["type"] == "tool_use"), None)
    if tool_use is None:
        return {
            "name": item["name"],
            "product": None,
            "quantity": 0,
            "reason": "model gave no decision",
            "decided_by": "agent",
            "is_substitute": is_substitute,
        }

    decision = tool_use["input"]
    if decision.get("skip") or not decision.get("product_id"):
        return {
            "name": item["name"],
            "product": None,
            "quantity": 0,
            "reason": decision.get("reason", "skipped"),
            "decided_by": "agent",
            "is_substitute": is_substitute,
        }

    return {
        "name": item["name"],
        "product": raw_by_id.get(str(decision["product_id"])),
        "quantity": max(1, int(decision.get("quantity", 1))),
        "reason": decision.get("reason", ""),
        "decided_by": "agent",
        "is_substitute": is_substitute,
    }


def main() -> None:
    urls = sys.argv[1:]
    if not urls:
        sys.exit("usage: python agent.py <recipe_url> [<recipe_url> ...]")

    print("parsing recipes...")
    recipes = []
    for url in urls:
        recipe = parse_recipe(url)
        print(f"  {recipe['title']} — {len(recipe['ingredients'])} ingredients")
        recipes.append(recipe)

    shopping_list, skipped = build_shopping_list(recipes)
    print(f"\nshopping list: {len(shopping_list)} items ({len(skipped)} skipped)\n")

    goal = build_goal(shopping_list, skipped)
    messages = [{"role": "user", "content": goal}]

    max_steps = max(MIN_STEPS, STEPS_PER_ITEM * len(shopping_list))
    for step in range(1, max_steps + 1):
        print(f"---------- step {step} ----------")
        reply = call_model(messages)
        messages.append({"role": "assistant", "content": reply["content"]})

        if reply["stop_reason"] != "tool_use":
            answer = "".join(b.get("text", "") for b in reply["content"] if b["type"] == "text")
            print(f"\nanswer: {' '.join(answer.split())}")
            return

        results = [run_tool(b) for b in reply["content"] if b["type"] == "tool_use"]
        messages.append({"role": "user", "content": results})

    print("stopped after max_steps without a final answer.")


if __name__ == "__main__":
    main()
