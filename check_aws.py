"""
Quick sanity check: do our AWS credentials work, and can we reach Bedrock?

    python check_aws.py

Two separate checks, because they fail for different reasons:
  1. sts.get_caller_identity() — are the credentials even valid?
  2. bedrock invoke_model() — do we specifically have model access?
"""

import json
import sys

import boto3
from dotenv import load_dotenv

load_dotenv()

# This sandbox account's org policy only allows ON_DEMAND models, not the
# cross-region "global."/"apac." inference-profile ones (both were denied by
# an explicit SCP) — found by testing candidates directly against the account.
MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"


def main() -> None:
    session = boto3.Session()

    print("1. checking credentials...")
    try:
        identity = session.client("sts").get_caller_identity()
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"   FAILED — credentials are not valid: {exc}")
    print(f"   OK — signed in as {identity['Arn']}")

    print("2. checking Bedrock model access...")
    client = session.client("bedrock-runtime")
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 20,
            "messages": [{"role": "user", "content": "Say 'ready' and nothing else."}],
        }
    )
    try:
        response = client.invoke_model(modelId=MODEL_ID, body=body)
    except Exception as exc:  # noqa: BLE001
        sys.exit(
            f"   FAILED — {exc}\n"
            "   Most likely: Bedrock model access hasn't been enabled yet.\n"
            "   AWS console -> Bedrock -> Model access -> enable Claude Haiku 4.5,\n"
            "   in the ap-southeast-1 region."
        )
    payload = json.loads(response["body"].read())
    text = payload["content"][0]["text"]
    print(f"   OK — model said: {text!r}")

    print("\nAll good — ready to build the agent.")


if __name__ == "__main__":
    main()
