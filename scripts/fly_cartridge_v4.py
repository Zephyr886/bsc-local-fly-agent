"""Fly Cartridge v4: canonical Profile plus the verified v3 learned-trait state.

This is a local format. It does not imply that Registry V3 or a future Registry
V4 accepts the bytes. The verifier is intentionally separate from v3 so the v3
field contract remains exact and unchanged.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any

import fly_cartridge_state_ref as ref
import fly_cartridge_v2 as v2
import fly_cartridge_v3 as v3

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas/fly-profile-v1.schema.json"
BALANCED_PATH = ROOT / "src/profile/presets/balanced-v1.json"
FORMAT = "fly-cartridge"
FORMAT_VERSION = 4
SEMANTICS = "profile-and-learned-trait;fresh-neural-boot"
MODEL = "stonkfly-dual-compartment-v1"
PROFILE_BRAIN_MODEL = "malecns-v1"
PROFILE_STRATEGY = "hybrid-v2-profiled"
MAX_MANIFEST = 32_768
MAX_STATE = v3.MAX_STATE
V3_MAX_MANIFEST = 16_384
V3_MAX_PUBLICATION = 120_000
TOP_LEVEL = frozenset(("format", "formatVersion", "semantics", "fly", "profile",
                       "model", "locks", "traitKey", "fieldSha256", "state",
                       "training", "lineage", "provenance", "fixedBootProbe"))
SECRET_KEYS = frozenset(("privateKey", "private_key", "mnemonic", "seedPhrase",
                         "seed_phrase", "keystore", "password", "rpcUrl", "rpcURL",
                         "authorizationId", "calldata"))
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
CARD_ID = re.compile(r"0x[0-9a-f]{64}\Z")
ADDRESS = re.compile(r"0x(?!0{40}\Z)[0-9a-fA-F]{40}\Z")


def _pairs(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def strict_json(raw: bytes | str) -> Any:
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    return json.loads(text, object_pairs_hook=_pairs, parse_constant=lambda value: (_ for _ in ()).throw(
        ValueError(f"Nonfinite JSON number: {value}")))


def _number(value: int | float) -> str:
    if isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("Canonical JSON requires finite numbers")
    if isinstance(value, int) or value.is_integer():
        return str(int(value))
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    return re.sub(r"e([+-])0+(\d+)", r"e\1\2", encoded)


def canonical_json(value: Any) -> str:
    """Match Profile v1's JSON.stringify-style canonical representation."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{canonical_json(value[key])}"
            for key in sorted(value)
        ) + "}"
    raise ValueError("Canonical JSON accepts only JSON values")


def canonical_manifest(value: dict) -> bytes:
    return (canonical_json(value) + "\n").encode("utf-8")


def profile_hash(spec: dict) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(spec).encode("utf-8")).hexdigest()


def _type_matches(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if expected == "integer":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and float(value).is_integer()
    return False


def _schema_error(path: str, message: str) -> None:
    raise ValueError(f"Profile Schema invalid at {path or '/'}: {message}")


def _validate_schema(value: Any, schema: dict, root: dict, path: str = "") -> None:
    if "$ref" in schema:
        prefix = "#/$defs/"
        if not schema["$ref"].startswith(prefix):
            _schema_error(path, "unsupported schema reference")
        return _validate_schema(value, root["$defs"][schema["$ref"][len(prefix):]], root, path)
    if "anyOf" in schema:
        successes = 0
        for candidate in schema["anyOf"]:
            try:
                _validate_schema(value, candidate, root, path)
                successes += 1
            except ValueError:
                pass
        if successes != 1:
            _schema_error(path, "must match exactly one allowed shape")
        return
    if "const" in schema and value != schema["const"]:
        _schema_error(path, f"must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        _schema_error(path, "value is not allowed")
    expected = schema.get("type")
    if expected and not _type_matches(value, expected):
        _schema_error(path, f"must be {expected}")
    if expected == "object":
        properties = schema.get("properties", {})
        missing = [key for key in schema.get("required", []) if key not in value]
        if missing:
            _schema_error(path, f"missing fields: {', '.join(missing)}")
        if schema.get("additionalProperties") is False:
            unknown = [key for key in value if key not in properties]
            if unknown:
                _schema_error(path, f"unknown fields: {', '.join(unknown)}")
        for key, child in value.items():
            if key in properties:
                _validate_schema(child, properties[key], root, f"{path}/{key}")
    elif expected == "array":
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            _schema_error(path, "array length is outside bounds")
        if schema.get("uniqueItems") and len({canonical_json(item) for item in value}) != len(value):
            _schema_error(path, "array items must be unique")
        for index, item in enumerate(value):
            _validate_schema(item, schema.get("items", {}), root, f"{path}/{index}")
    elif expected == "string":
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            _schema_error(path, "string length is outside bounds")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            _schema_error(path, "string pattern mismatch")
    elif expected in ("number", "integer"):
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            _schema_error(path, "number is outside bounds")
        multiple = schema.get("multipleOf")
        if multiple and not math.isclose(value / multiple, round(value / multiple), abs_tol=1e-10):
            _schema_error(path, f"must be a multiple of {multiple}")


def _scan_forbidden(value: Any, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in SECRET_KEYS:
                raise ValueError(f"Forbidden secret-bearing field at {path}/{key}")
            _scan_forbidden(child, f"{path}/{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_forbidden(child, f"{path}/{index}")
    elif isinstance(value, str) and re.match(r"https?://", value, re.IGNORECASE):
        raise ValueError(f"Profile must not contain URLs at {path}")


def validate_profile_spec(spec: Any) -> dict:
    if not isinstance(spec, dict):
        raise ValueError("Profile spec must be an object")
    _scan_forbidden(spec)
    schema = strict_json(SCHEMA_PATH.read_bytes())
    _validate_schema(spec, schema["$defs"]["spec"], schema, "/profile")
    universe = spec["universe"]
    if universe["tokenBinding"] == "fixed":
        if not isinstance(universe["tokenAddress"], str) or not ADDRESS.fullmatch(universe["tokenAddress"]):
            _schema_error("/profile/universe/tokenAddress", "fixed binding requires a nonzero address")
    elif universe["tokenAddress"] is not None:
        _schema_error("/profile/universe/tokenAddress", "device-selected binding requires null")
    horizons = spec["reward"]["settlementHorizonsSeconds"]
    if any(value <= horizons[index - 1] for index, value in enumerate(horizons) if index):
        _schema_error("/profile/reward/settlementHorizonsSeconds", "must be strictly increasing")
    if spec["reward"]["primaryHorizonSeconds"] not in horizons:
        _schema_error("/profile/reward/primaryHorizonSeconds", "must occur in settlement horizons")
    weights = [spec["reward"][name] for name in ("followWeight", "positionWeight", "favorableWeight", "drawdownWeight")]
    if sum(abs(value) for value in weights) > 1.5 + 1e-12 or not any(value > 0 for value in weights):
        _schema_error("/profile/reward", "reward weights violate the cross-field policy")
    strategy = spec["strategy"]
    if strategy["activeMaxActions"] < strategy["activeMinActions"] or strategy["quietMaxActions"] < strategy["quietMinActions"]:
        _schema_error("/profile/strategy", "maximum actions must not be lower than minimum actions")
    compatibility = spec["compatibility"]
    if compatibility != {"brainModel": PROFILE_BRAIN_MODEL,
                          "strategyEngine": PROFILE_STRATEGY,
                          "profileSchemaVersion": 1}:
        raise ValueError("Profile model compatibility is not supported by Cartridge v4")
    return spec


def validate_profile_document(document: Any) -> dict:
    schema = strict_json(SCHEMA_PATH.read_bytes())
    _validate_schema(document, schema, schema, "")
    validate_profile_spec(document["spec"])
    metadata = document["metadata"]
    timestamps = {}
    for field in ("createdAt", "updatedAt"):
        try:
            timestamps[field] = datetime.fromisoformat(metadata[field].replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"Profile {field} must be RFC3339") from error
    if timestamps["updatedAt"] < timestamps["createdAt"]:
        raise ValueError("Profile updatedAt must not be before createdAt")
    expected = profile_hash(document["spec"])
    if metadata["profileHash"] != expected:
        raise ValueError(f"Profile hash mismatch; expected {expected}")
    return document


def _training(value: Any) -> dict:
    if value is None:
        return {"runId": None, "completedAt": None, "datasetHash": None}
    if not isinstance(value, dict):
        raise ValueError("training provenance must be an object")
    if set(value) == {"runId", "completedAt", "datasetHash"}:
        result = value
    else:
        run_id = value.get("id")
        completed = value.get("stoppedAt") if value.get("status") == "completed" else None
        dataset_hash = value.get("summary", {}).get("source", {}).get("datasetHash")
        result = {"runId": run_id, "completedAt": completed, "datasetHash": dataset_hash}
    if result["runId"] is not None and not UUID.fullmatch(result["runId"]):
        raise ValueError("training.runId must be a UUID or null")
    if result["completedAt"] is not None:
        try:
            datetime.fromisoformat(result["completedAt"].replace("Z", "+00:00"))
        except (TypeError, ValueError) as error:
            raise ValueError("training.completedAt must be RFC3339 or null") from error
    if result["datasetHash"] is not None and not SHA256.fullmatch(result["datasetHash"]):
        raise ValueError("training.datasetHash must be sha256 or null")
    return result


def _lineage(value: Any = None) -> dict:
    value = value or {"parentRegistry": None, "parentCardId": None}
    if not isinstance(value, dict) or set(value) != {"parentRegistry", "parentCardId"}:
        raise ValueError("lineage fields are invalid")
    both_null = value["parentRegistry"] is None and value["parentCardId"] is None
    both_set = isinstance(value["parentRegistry"], str) and ADDRESS.fullmatch(value["parentRegistry"]) and \
        isinstance(value["parentCardId"], str) and CARD_ID.fullmatch(value["parentCardId"])
    if not (both_null or both_set):
        raise ValueError("lineage parent registry and card must be both null or both valid")
    return value


def _provenance(value: Any = None) -> dict:
    value = value or {"sourceFormatVersion": 4, "sourceCardId": None}
    if not isinstance(value, dict) or set(value) != {"sourceFormatVersion", "sourceCardId"} \
            or value["sourceFormatVersion"] not in (3, 4):
        raise ValueError("provenance fields are invalid")
    if value["sourceFormatVersion"] == 3:
        if not isinstance(value["sourceCardId"], str) or not CARD_ID.fullmatch(value["sourceCardId"]):
            raise ValueError("v3 provenance requires its source Card ID")
    elif value["sourceCardId"] is not None:
        raise ValueError("native v4 provenance sourceCardId must be null")
    return value


def build_manifest(*, profile_document: dict, arrays: dict, state: bytes, locks: dict,
                   fixed_boot_probe: dict, training: Any = None, lineage: Any = None,
                   provenance: Any = None) -> dict:
    validate_profile_document(profile_document)
    metadata = profile_document["metadata"]
    field_hashes = {name: ref.digest(ref._array_bytes(arrays[name])) for name in v3.FIELDS}
    manifest = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "semantics": SEMANTICS,
        "fly": {
            "flyId": metadata["flyId"],
            "profileSchemaVersion": profile_document["spec"]["compatibility"]["profileSchemaVersion"],
            "profileRevision": metadata["revision"],
            "profileHash": metadata["profileHash"],
        },
        "profile": profile_document["spec"],
        "model": MODEL,
        "locks": locks,
        "traitKey": v3.trait_key(arrays, locks),
        "fieldSha256": field_hashes,
        "state": {"bytes": len(state), "sha256": v2.sha(state)},
        "training": _training(training),
        "lineage": _lineage(lineage),
        "provenance": _provenance(provenance),
        "fixedBootProbe": fixed_boot_probe,
    }
    raw = canonical_manifest(manifest)
    if len(raw) > MAX_MANIFEST or len(state) > MAX_STATE:
        raise ValueError("Cartridge v4 exceeds local size limits")
    return manifest


def _write(target: Path, manifest: dict, state: bytes) -> dict:
    if target.exists():
        raise ValueError("Output directory already exists")
    raw = canonical_manifest(manifest)
    target.mkdir(parents=True)
    (target / "cartridge.json").write_bytes(raw)
    (target / "state.bin").write_bytes(state)
    return {"cardId": v2.sha(raw), "profileHash": manifest["fly"]["profileHash"],
            "traitKey": manifest["traitKey"], "stateSha256": manifest["state"]["sha256"],
            "stateBytes": len(state), "manifestBytes": len(raw)}


def export(checkpoint: Path, profile_path: Path, target: Path, *, training_path: Path | None = None,
           lineage: dict | None = None) -> dict:
    profile_document = validate_profile_document(strict_json(profile_path.read_bytes()))
    base_all, brain = ref.baseline()
    brain.restore(checkpoint)
    arrays = {name: getattr(brain, name).copy() for name in v3.FIELDS}
    base = {name: base_all[name] for name in v3.FIELDS}
    state = v3.encode_arrays(arrays, base)
    training = strict_json(training_path.read_bytes()) if training_path else None
    manifest = build_manifest(profile_document=profile_document, arrays=arrays, state=state,
                              locks=v3.shared_locks(), fixed_boot_probe=v3.probe(brain, arrays),
                              training=training, lineage=lineage)
    result = _write(target, manifest, state)
    verified = verify(target)
    if verified["cardId"] != result["cardId"]:
        raise AssertionError("Cartridge v4 roundtrip failed")
    return {**result, "publishability": publishability(target)}


def _validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict) or set(manifest) != TOP_LEVEL:
        raise ValueError("Invalid Cartridge v4 manifest fields")
    if manifest["format"] != FORMAT or manifest["formatVersion"] != FORMAT_VERSION \
            or manifest["semantics"] != SEMANTICS or manifest["model"] != MODEL:
        raise ValueError("Invalid Cartridge v4 identity")
    fly = manifest["fly"]
    if not isinstance(fly, dict) or set(fly) != {"flyId", "profileSchemaVersion", "profileRevision", "profileHash"} \
            or not UUID.fullmatch(fly["flyId"]) or fly["profileSchemaVersion"] != 1 \
            or not isinstance(fly["profileRevision"], int) or isinstance(fly["profileRevision"], bool) \
            or not 1 <= fly["profileRevision"] <= 999999 or not SHA256.fullmatch(fly["profileHash"]):
        raise ValueError("Invalid Cartridge v4 fly identity")
    validate_profile_spec(manifest["profile"])
    expected_profile_hash = profile_hash(manifest["profile"])
    if fly["profileHash"] != expected_profile_hash:
        raise ValueError("Cartridge v4 Profile hash mismatch")
    _training(manifest["training"])
    _lineage(manifest["lineage"])
    _provenance(manifest["provenance"])


def verify(directory: Path, boot_checkpoint: Path | None = None) -> dict:
    raw = (directory / "cartridge.json").read_bytes()
    state = (directory / "state.bin").read_bytes()
    if len(raw) > MAX_MANIFEST or len(state) > MAX_STATE or not raw or not state:
        raise ValueError("Cartridge v4 exceeds local size limits")
    manifest = strict_json(raw)
    if raw != canonical_manifest(manifest):
        raise ValueError("Cartridge v4 manifest is not canonical")
    _validate_manifest(manifest)
    if manifest["state"] != {"bytes": len(state), "sha256": v2.sha(state)}:
        raise ValueError("Cartridge v4 state commitment mismatch")
    if not v3.locks_compatible(manifest["locks"]):
        raise ValueError("Cartridge v4 shared runtime mismatch")
    base_all, brain = ref.baseline()
    base = {name: base_all[name] for name in v3.FIELDS}
    arrays = v3.decode_arrays(state, base)
    field_hashes = {name: ref.digest(ref._array_bytes(arrays[name])) for name in v3.FIELDS}
    if manifest["fieldSha256"] != field_hashes or manifest["traitKey"] != v3.trait_key(arrays, manifest["locks"]):
        raise ValueError("Cartridge v4 trait identity mismatch")
    if manifest["fixedBootProbe"] != v3.probe(brain, arrays):
        raise ValueError("Cartridge v4 boot probe mismatch")
    if boot_checkpoint is not None:
        if boot_checkpoint.exists():
            raise ValueError("Boot checkpoint already exists")
        v3.boot(brain, arrays)
        brain.checkpoint(boot_checkpoint)
    return {"cardId": v2.sha(raw), "profileHash": manifest["fly"]["profileHash"],
            "traitKey": manifest["traitKey"], "stateSha256": manifest["state"]["sha256"],
            "stateBytes": len(state), "manifestBytes": len(raw),
            "fly": manifest["fly"], "profile": manifest["profile"],
            "training": manifest["training"], "lineage": manifest["lineage"],
            "provenance": manifest["provenance"], "fixedBootProbe": manifest["fixedBootProbe"]}


def install(directory: Path, target: Path) -> dict:
    if target.exists():
        raise ValueError("Device checkpoint directory already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fly-v4-", dir=target.parent) as temporary:
        staged = Path(temporary) / "checkpoint"
        staged.mkdir()
        result = verify(directory, staged / "service.npz")
        profile = result["profile"]
        token = profile["universe"]["tokenAddress"] if profile["universe"]["tokenBinding"] == "fixed" else None
        marker = {
            "flyId": result["fly"]["flyId"],
            "profileRevision": result["fly"]["profileRevision"],
            "profileHash": result["profileHash"],
            "modelVersion": PROFILE_BRAIN_MODEL,
            "tokenAddress": token,
            "tokenContext": {"address": token, "symbol": None},
            "learningEnabled": profile["learning"]["enabled"],
            "savedAt": None,
            "weightSha256": v2.file_sha(staged / "service.npz"),
            "cartridge": {"formatVersion": 4, "cardId": "0x" + result["cardId"],
                          "provenance": result["provenance"]},
        }
        (staged / "service.json").write_bytes(canonical_manifest(marker))
        (staged / "profile.json").write_bytes(canonical_manifest(profile))
        os.rename(staged, target)
    return {**result, "deviceCheckpoint": str(target / "service.npz"),
            "deviceMarker": str(target / "service.json")}


def wrap_v3(directory: Path, target: Path, fly_id: str) -> dict:
    if not UUID.fullmatch(fly_id):
        raise ValueError("flyId must be a UUID")
    v3_result = v3.verify(directory)
    v3_manifest = strict_json((directory / "cartridge.json").read_bytes())
    state = (directory / "state.bin").read_bytes()
    preset = strict_json(BALANCED_PATH.read_bytes())
    spec = validate_profile_spec(preset["spec"])
    document = {
        "apiVersion": "flap.ai/v1", "kind": "FlyProfile",
        "metadata": {"flyId": fly_id, "revision": 1, "name": "Imported v3",
                     "description": "Wrapped from Fly Cartridge v3", "tags": ["v3-import"],
                     "createdAt": "1970-01-01T00:00:00.000Z", "updatedAt": "1970-01-01T00:00:00.000Z",
                     "profileHash": profile_hash(spec)},
        "spec": spec,
    }
    base_all, _ = ref.baseline()
    arrays = v3.decode_arrays(state, {name: base_all[name] for name in v3.FIELDS})
    manifest = build_manifest(profile_document=document, arrays=arrays, state=state,
                              locks=v3_manifest["locks"], fixed_boot_probe=v3_manifest["fixedBootProbe"],
                              provenance={"sourceFormatVersion": 3,
                                          "sourceCardId": "0x" + v3_result["cardId"]})
    return {**_write(target, manifest, state), "sourceFormatVersion": 3,
            "sourceCardId": "0x" + v3_result["cardId"]}


def publishability(directory: Path, known_v3_state_hashes: set[str] | None = None) -> dict:
    reasons = []
    try:
        result = verify(directory)
        manifest = strict_json((directory / "cartridge.json").read_bytes())
    except (OSError, ValueError) as error:
        return {"localValid": False, "candidateForV3Compatibility": False,
                "publishableToRegistryV3": False,
                "reasons": [{"code": "LOCAL_VERIFICATION_FAILED", "message": str(error)}]}
    if result["manifestBytes"] > V3_MAX_MANIFEST:
        reasons.append({"code": "V3_MANIFEST_LIMIT", "message": "Manifest exceeds the Registry V3 limit"})
    if result["manifestBytes"] + result["stateBytes"] > V3_MAX_PUBLICATION:
        reasons.append({"code": "V3_TOTAL_LIMIT", "message": "Manifest and state exceed the Registry V3 transaction limit"})
    if known_v3_state_hashes and result["stateSha256"] in known_v3_state_hashes:
        reasons.append({"code": "V3_DUPLICATE_STATE", "message": "Registry V3 already contains this state hash"})
    if manifest["lineage"]["parentRegistry"] is not None:
        reasons.append({"code": "V3_PARENT_UNSUPPORTED", "message": "Registry V3 cannot preserve v4 cross-registry lineage"})
    candidate = not reasons
    if candidate:
        reasons.append({"code": "V3_CARRIER_NOT_APPROVED",
                        "message": "V4 bytes require reader and publisher compatibility testing before Registry V3 use"})
    return {"localValid": True, "candidateForV3Compatibility": candidate,
            "publishableToRegistryV3": False, "profileComplete": True,
            "manifestBytes": result["manifestBytes"], "stateBytes": result["stateBytes"],
            "stateSha256": result["stateSha256"], "reasons": reasons}


def _parent(args) -> dict:
    return _lineage({"parentRegistry": args.parent_registry, "parentCardId": args.parent_card_id})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("export")
    make.add_argument("--checkpoint", type=Path, required=True)
    make.add_argument("--profile", type=Path, required=True)
    make.add_argument("--training-run", type=Path)
    make.add_argument("--parent-registry")
    make.add_argument("--parent-card-id")
    make.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("directory", type=Path)
    check.add_argument("--boot-checkpoint", type=Path)
    load = commands.add_parser("install")
    load.add_argument("directory", type=Path)
    load.add_argument("--out", type=Path, required=True)
    wrap = commands.add_parser("wrap-v3")
    wrap.add_argument("directory", type=Path)
    wrap.add_argument("--fly-id", required=True)
    wrap.add_argument("--out", type=Path, required=True)
    report = commands.add_parser("publishability")
    report.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "export":
        result = export(args.checkpoint, args.profile, args.out,
                        training_path=args.training_run, lineage=_parent(args))
    elif args.command == "verify":
        result = verify(args.directory, args.boot_checkpoint)
    elif args.command == "install":
        result = install(args.directory, args.out)
    elif args.command == "wrap-v3":
        result = wrap_v3(args.directory, args.out, args.fly_id)
    else:
        result = publishability(args.directory)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
