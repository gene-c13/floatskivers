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
from tools.cart import add_to_cart, search_products

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


def call_model(messages: list, max_retries: int = 6) -> dict:
    """One model turn, retrying through throttling with growing waits."""
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "tools": TOOL_SPECS,
            "messages": messages,
        }
    )
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
