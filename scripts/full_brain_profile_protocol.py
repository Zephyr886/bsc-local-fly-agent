"""Strict Profile v1 protocol validation for the stdin-only MaleCNS worker."""

import math
import re


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN = re.compile(r"^0x(?!0{40}$)[0-9a-f]{40}$")
PROFILE_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
WEIGHT_HASH = re.compile(r"^[0-9a-f]{64}$")

OBSERVE_FIELDS = {
    "method", "id", "flyId", "profileRevision", "profileHash", "modelVersion",
    "tokenAddress", "symbol", "history", "price", "pulse", "pulseStrength",
    "learning", "neuralMs", "thresholdHz", "checkpointEverySeconds",
}
SAVE_FIELDS = {"method", "id"}


def _exact_fields(value, expected):
    unknown = sorted(set(value) - expected)
    missing = sorted(expected - set(value))
    if unknown:
        raise ValueError(f"Request contains unknown fields: {', '.join(unknown)}")
    if missing:
        raise ValueError(f"Request is missing fields: {', '.join(missing)}")


def _integer(value, name, low, high=None):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or (high is not None and value > high):
        raise ValueError(f"Invalid {name}")
    return value


def _number(value, name, low, high, *, exclusive_low=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid {name}")
    if (value <= low if exclusive_low else value < low) or value > high:
        raise ValueError(f"Invalid {name}")
    return float(value)


def validate_request(value):
    if not isinstance(value, dict):
        raise ValueError("Request must be an object")
    method = value.get("method")
    if method == "save":
        _exact_fields(value, SAVE_FIELDS)
        return {"method": "save", "id": _integer(value["id"], "id", 1)}
    if method != "observe":
        raise ValueError("Unknown worker method")
    _exact_fields(value, OBSERVE_FIELDS)
    if not isinstance(value["flyId"], str) or not UUID.fullmatch(value["flyId"]):
        raise ValueError("Invalid flyId")
    if value["modelVersion"] != "malecns-v1":
        raise ValueError("Invalid modelVersion")
    if not isinstance(value["profileHash"], str) or not PROFILE_HASH.fullmatch(value["profileHash"]):
        raise ValueError("Invalid profileHash")
    token = value["tokenAddress"].lower() if isinstance(value["tokenAddress"], str) else ""
    if not TOKEN.fullmatch(token):
        raise ValueError("Invalid tokenAddress")
    symbol = value["symbol"]
    if not isinstance(symbol, str) or not 1 <= len(symbol) <= 32 or any(ord(char) < 32 for char in symbol):
        raise ValueError("Invalid symbol")
    history = value["history"]
    if not isinstance(history, list) or not 1 <= len(history) <= 360:
        raise ValueError("Invalid history")
    normalized_history = [_number(item, "history", 0, float("inf"), exclusive_low=True) for item in history]
    if value["pulse"] not in {"none", "reward", "aversive"}:
        raise ValueError("Invalid pulse")
    if not isinstance(value["learning"], bool):
        raise ValueError("Invalid learning")
    return {
        **value,
        "id": _integer(value["id"], "id", 1),
        "profileRevision": _integer(value["profileRevision"], "profileRevision", 1, 999999),
        "tokenAddress": token,
        "history": normalized_history,
        "price": _number(value["price"], "price", 0, float("inf"), exclusive_low=True),
        "pulseStrength": _number(value["pulseStrength"], "pulseStrength", 0, 1),
        "neuralMs": _number(value["neuralMs"], "neuralMs", 100, 2000),
        "thresholdHz": _number(value["thresholdHz"], "thresholdHz", 0.1, 50),
        "checkpointEverySeconds": _integer(
            value["checkpointEverySeconds"], "checkpointEverySeconds", 30, 3600),
    }


def checkpoint_metadata(context, saved_at, weight_sha256):
    if not isinstance(weight_sha256, str) or not WEIGHT_HASH.fullmatch(weight_sha256):
        raise ValueError("Invalid weight SHA-256")
    return {
        "flyId": context["flyId"],
        "profileRevision": context["profileRevision"],
        "profileHash": context["profileHash"],
        "modelVersion": context["modelVersion"],
        "tokenAddress": context["tokenAddress"],
        "tokenContext": {
            "address": context["tokenAddress"],
            "symbol": context["symbol"],
        },
        "learningEnabled": context["learning"],
        "savedAt": saved_at,
        "weightSha256": weight_sha256,
    }


def checkpoint_matches(metadata, context):
    return (
        isinstance(metadata, dict)
        and metadata.get("flyId") == context["flyId"]
        and metadata.get("modelVersion") == context["modelVersion"]
    )
