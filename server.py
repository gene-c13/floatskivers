"""Local backend for the browser extension.

Wraps recipe_parser so the extension (JavaScript) can call the already
tested Python parsing/merging logic over HTTP instead of it being ported
to JS. Not deployed anywhere yet: run locally with

    python3 server.py

and the extension talks to http://localhost:5050.

Not port 5000: macOS's AirPlay Receiver (ControlCenter) squats on it and
returns 403 to anything it doesn't recognize as an AirPlay request.
"""
import os

from flask import Flask, jsonify, request
from flask_cors import CORS

from agent import choose_product_for_item
from recipe_parser import build_shopping_list, parse_recipe

app = Flask(__name__)
CORS(app)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/shopping-list", methods=["POST"])
def shopping_list():
    data = request.get_json(force=True, silent=True) or {}
    requested = data.get("recipes", [])
    if not requested:
        return jsonify({"error": "no recipes provided"}), 400

    recipes = []
    parsed = []
    errors = []
    for entry in requested:
        url = entry.get("url", "")
        html = entry.get("html")
        try:
            # The extension sends the page's own HTML (read from the tab
            # the user is already on) instead of just a URL: AllRecipes'
            # bot protection blocks the backend fetching pages itself.
            recipe = parse_recipe(html if html else url)
            recipes.append(recipe)
            parsed.append({"title": recipe["title"], "url": url})
        except Exception as exc:  # noqa: BLE001
            errors.append({"url": url, "error": str(exc)})

    items, skipped = build_shopping_list(recipes) if recipes else ([], [])

    return jsonify({
        "recipes": parsed,
        "shopping_list": items,
        "skipped": skipped,
        "errors": errors,
    })


@app.route("/pick-products", methods=["POST"])
def pick_products():
    """Given items already searched and ranked by extension/popup.js
    (scoreProduct/rankFairPriceMatches — the cart team's own logic, not
    reimplemented here), let the Bedrock agent make the final call on each
    one: which candidate to add, and how many. popup.js still does the
    actual FairPrice search itself; this endpoint only ever decides.

    Expects {"items": [{"name", "quantity", "unit",
    "needs_manual_reconciliation", "is_substitute", "candidates": [
    {"product": <raw FairPrice product>, "score", "recommended_quantity"},
    ...]}, ...]}. Requires AWS credentials with Bedrock access in this
    process's environment, same as running agent.py locally does.
    """
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "no items provided"}), 400

    picks = []
    for item in items:
        try:
            picks.append(choose_product_for_item(item))
        except Exception as exc:  # noqa: BLE001
            picks.append({
                "name": item.get("name"),
                "product": None,
                "quantity": 0,
                "reason": str(exc),
                "decided_by": "error",
                "is_substitute": False,
            })

    return jsonify({"picks": picks})


if __name__ == "__main__":
    # 0.0.0.0 so this is reachable from outside a container; PORT lets a
    # hosting platform (e.g. App Runner) assign its own port, defaulting
    # to 5050 for local dev (not 5000: macOS AirPlay Receiver owns that).
    # debug=False: this gets exposed publicly, and Flask's debugger is a
    # known remote-code-execution risk once that's the case.
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
