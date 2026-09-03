"""
Step 2 demo: the same "check stock, restock if low" agent loop from the
workshop lab (section_2_agentic_ai_basic/00_anatomy_of_an_agent.py), rebuilt
directly against Bedrock with retry-with-backoff around every model call.

This sandbox AWS account throttles Bedrock InvokeModel calls unpredictably
(it's a shared account, likely under load from other hackathon teams), so a
call_model() that gives up after one try isn't good enough — this is the
pattern agent.py will reuse for real.

    python demo_loop.py
"""

import json
import time

import boto3
from dotenv import load_dotenv

load_dotenv()

MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"
MAX_STEPS = 5

client = boto3.Session().client("bedrock-runtime", region_name="ap-southeast-1")


# ---------------------------------------------------------------- tools

def check_stock(sku: str) -> str:
    print(f"      [tool] check_stock({sku!r})")
    return f"{sku}: 12 units"


def raise_purchase_order(sku: str, qty: int) -> str:
    print(f"      [tool] raise_purchase_order({sku!r}, {qty!r})")
    return f"PO-4471 raised for {qty} x {sku}"


REGISTRY = {"check_stock": check_stock, "raise_purchase_order": raise_purchase_order}

TOOL_SPECS = [
    {
        "name": "check_stock",
        "description": "Units currently in stock for one SKU.",
        "input_schema": {
            "type": "object",
            "properties": {"sku": {"type": "string"}},
            "required": ["sku"],
        },
    },
    {
        "name": "raise_purchase_order",
        "description": "Place a restock order.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sku": {"type": "string"},
                "qty": {"type": "integer"},
            },
            "required": ["sku", "qty"],
        },
    },
]


# ---------------------------------------------------------------- the retrying call

def call_model(messages: list, max_retries: int = 6) -> dict:
    """One model turn, retrying through throttling with growing waits."""
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 512,
            "tools": TOOL_SPECS,
            "messages": messages,
        }
    )
    wait = 5
    for attempt in range(1, max_retries + 1):
        try:
            response = client.invoke_model(modelId=MODEL_ID, body=body)
            return json.loads(response["body"].read())
        except client.exceptions.ThrottlingException:
            if attempt == max_retries:
                raise
            print(f"      [throttled — waiting {wait}s, attempt {attempt}/{max_retries}]")
            time.sleep(wait)
            wait = min(wait * 2, 60)


def run_tool(block: dict) -> dict:
    fn = REGISTRY[block["name"]]
    result = fn(**block["input"])
    return {
        "type": "tool_result",
        "tool_use_id": block["id"],
        "content": [{"type": "text", "text": result}],
    }


def main() -> None:
    goal = (
        "SKU-77 may be running low. Check it, and restock if it is below "
        "the reorder level of 50."
    )
    print(f"goal: {goal}\n")
    messages = [{"role": "user", "content": goal}]

    for step in range(1, MAX_STEPS + 1):
        print(f"---------- step {step} ----------")
        reply = call_model(messages)
        messages.append({"role": "assistant", "content": reply["content"]})

        if reply["stop_reason"] != "tool_use":
            answer = "".join(b.get("text", "") for b in reply["content"] if b["type"] == "text")
            print(f"answer: {' '.join(answer.split())}")
            return

        results = [run_tool(b) for b in reply["content"] if b["type"] == "tool_use"]
        messages.append({"role": "user", "content": results})

    print("stopped at MAX_STEPS without a final answer.")


if __name__ == "__main__":
    main()
