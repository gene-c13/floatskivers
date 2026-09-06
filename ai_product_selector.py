"""Backend-only AI selection for FairPrice search results."""
import json
import os


def _fallback(products, fallback_selector):
    return {"product": fallback_selector(products), "reason": "Deterministic FairPrice matching fallback.", "confidence": 0.0, "source": "fallback"}


def select_product(payload, products, fallback_selector, model_call=None):
    """Select one supplied product, or use the existing selector on any failure.

    model_call receives a prompt and returns decoded JSON (or a JSON string).
    Keeping it injectable makes this component deterministic in tests.
    """
    if not products:
        return {"product": None, "status": "not_found", "reason": "Not found on FairPrice", "confidence": 0.0, "source": "search"}
    available = [p for p in products if p.get("has_stock") is not False]
    if not available:
        return {"product": None, "status": "out_of_stock", "reason": "Out of stock", "confidence": 0.0, "source": "search"}
    model_call = model_call or _bedrock_call
    allowed = {str(product.get("id")): product for product in available if product.get("id") is not None}
    try:
        answer = model_call(_prompt(payload, available))
        if isinstance(answer, str):
            answer = json.loads(answer)
        status = answer.get("status", "matched")
        if status == "no_suitable_match":
            return {"product": None, "status": "no_suitable_match", "reason": str(answer.get("reason", "No suitable match found")), "confidence": 0.0, "source": "ai"}
        selected_id = str(answer["selected_product_id"])
        confidence = float(answer.get("confidence", 0.0))
        if selected_id not in allowed or not 0.5 <= confidence <= 1:
            raise ValueError("AI returned an invalid product selection")
        return {"product": allowed[selected_id], "status": "matched", "reason": str(answer.get("reason", "AI selected the best recipe match.")), "confidence": confidence, "source": "ai"}
    except Exception:
        product = fallback_selector(available)
        return {**_fallback(available, fallback_selector), "product": product, "status": "matched"}


def _prompt(payload, products):
    candidates = [{"product_id": p.get("id"), "name": p.get("name"), "description": p.get("description") or p.get("metaData", {}).get("SAP Product Name"), "price": p.get("final_price") or p.get("mrp"), "size": p.get("metaData", {}).get("DisplayUnit")} for p in products]
    return "Choose the best grocery product for this recipe ingredient. Return JSON only: status='matched' or 'no_suitable_match', selected_product_id (null for no_suitable_match), reason, confidence (0 to 1). Choose only an available supplied product ID; never invent products or IDs.\n" + json.dumps({"recipe_name": payload.get("recipe_name"), "ingredient": payload.get("ingredient"), "products": candidates}, ensure_ascii=False)


def _bedrock_call(prompt):
    import boto3
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 256, "messages": [{"role": "user", "content": prompt}]}
    client = boto3.Session().client("bedrock-runtime", region_name=os.getenv("AWS_REGION", "ap-southeast-1"))
    response = client.invoke_model(modelId=os.getenv("PRODUCT_SELECTOR_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0"), body=json.dumps(body))
    text = json.loads(response["body"].read())["content"][0]["text"]
    return json.loads(text)
