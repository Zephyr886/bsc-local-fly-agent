"""Candidate FlyCartridge v2 export/verify tool for an isolated local brain.

This wire format remains a candidate until the runtime is committed and a
public BSC testnet recovery succeeds. No wallet, RPC, SQLite or live process is
opened by this module.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
from datetime import datetime, timezone

import numpy as np

import fly_cartridge_state_ref as ref
from stonkfly.neural.brain import SOURCE
from stonkfly.neural.controller import Decoder
from stonkfly.neural.common import DATA, annotations

ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"FLY-CARTRIDGE-STATE-2\n"
DOMAIN = b"FlyCartridge/v2/state\0"
MAX_STATE = 8_388_608
MAX_MANIFEST = 65_536
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
SETTINGS = frozenset((
    "tokenAddress", "configVersion", "fullLearning", "fullNeuralMs",
    "fullThresholdHz", "fullObserveSeconds", "fullMinIntervalSeconds",
    "positionWindowSeconds", "activityWindowSeconds",
    "activityBaselineSeconds", "activityPriceLow", "activityPriceHigh",
    "activityVolumeWeight", "activityLow", "activityHigh",
    "activeMinIntervalSeconds", "quietMinIntervalSeconds",
    "activeThresholdScale", "quietThresholdScale", "quietPatienceMinutes",
    "quietRelaxFactor", "buyThreshold", "burnThreshold", "buyPercent",
    "burnPercent", "slippagePercent", "outcomeWindowSeconds",
    "rewardFloorPct", "rewardCeilPct", "positionWeight", "returnWeight",
    "trendWeight", "volumeWeight", "energyRisk",
))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


def source_sha(path: Path) -> str:
    return sha(path.read_bytes().replace(b"\r\n", b"\n"))


def runtime_tree_sha() -> str:
    root = ROOT / "vendor/stonkfly/stonkfly"
    files = {path.relative_to(root).as_posix(): source_sha(path)
             for path in root.rglob("*") if path.is_file()
             and path.suffix in {".py", ".cpp", ".json"}}
    return sha(ref.canonical(files))


def public_settings(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - SETTINGS:
        raise ValueError("Unknown or invalid public setting")
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", str(value.get("tokenAddress", ""))):
        raise ValueError("A public tokenAddress is required")
    neural_ms = value.get("fullNeuralMs")
    threshold = value.get("fullThresholdHz")
    if type(value.get("fullLearning")) is not bool or \
            type(neural_ms) not in (int, float) or not np.isfinite(neural_ms) or \
            not 200 <= neural_ms <= 1000 or \
            type(threshold) not in (int, float) or not np.isfinite(threshold) or \
            not 0.1 <= threshold <= 1000:
        raise ValueError("Invalid neural training settings")
    clean = {}
    for name, item in value.items():
        if name == "tokenAddress":
            clean[name] = item.lower()
        elif name == "fullLearning":
            if type(item) is not bool:
                raise ValueError("Invalid fullLearning")
            clean[name] = item
        elif name == "configVersion":
            if type(item) is not int or item < 0 or item > 2**31 - 1:
                raise ValueError("Invalid configVersion")
            clean[name] = item
        else:
            if type(item) not in (int, float) or not np.isfinite(item) or abs(item) > 1e12:
                raise ValueError(f"Invalid public setting: {name}")
            clean[name] = item
    return clean


def normalized_metadata(metadata: dict) -> dict:
    result = json.loads(json.dumps(metadata))
    if not ref.compatible_build_provenance(result.get("build", {}),
                                            {"model": result.get("model")}):
        raise ValueError("Kernel source differs from local locked runtime")
    rule = Path(SOURCE).with_name("rule.py")
    old_config = result.get("configuration_sha256")
    if not isinstance(old_config, dict):
        raise ValueError("Missing configuration provenance")
    current_config = {**old_config, "rule_sha256": sha(rule.read_bytes())}
    from stonkfly.neural.brain import compatible_configuration_signature
    if not compatible_configuration_signature(old_config, current_config):
        raise ValueError("Rule source differs from local locked runtime")
    result["build"] = {"model": result["model"], "source_sha256": source_sha(SOURCE)}
    result["configuration_sha256"]["rule_sha256"] = source_sha(rule)
    return result


def state_encode(checkpoint: Path, base: dict, brain) -> tuple[bytes, dict, dict]:
    # Verify the entire provenance contract before making a publishable file.
    brain.restore(checkpoint)
    experimental, _ = ref.encode(checkpoint, base, brain)
    length = struct.unpack_from("<I", experimental, len(ref.MAGIC))[0]
    offset = len(ref.MAGIC) + 4
    header = json.loads(experimental[offset:offset + length])
    header["metadata"] = normalized_metadata(header["metadata"])
    header["format"] = "fly-cartridge-state"
    header["version"] = 2
    encoded_header = ref.canonical(header)
    if len(encoded_header) > ref.MAX_HEADER:
        raise ValueError("State header exceeds limit")
    state = MAGIC + struct.pack("<I", len(encoded_header)) + encoded_header + experimental[offset + length:]
    if len(state) > MAX_STATE:
        raise ValueError("State exceeds 8 MiB limit")
    return state, header["metadata"], {field["name"]: field["valueSha256"] for field in header["fields"]}


def state_decode(state: bytes, base: dict) -> tuple[dict, dict, dict]:
    if not state.startswith(MAGIC) or len(state) < len(MAGIC) + 4 or len(state) > MAX_STATE:
        raise ValueError("Invalid state magic or length")
    length = struct.unpack_from("<I", state, len(MAGIC))[0]
    start = len(MAGIC) + 4
    if length > ref.MAX_HEADER or start + length > len(state):
        raise ValueError("Invalid state header length")
    raw = state[start:start + length]
    header = json.loads(raw)
    if raw != ref.canonical(header) or header.get("format") != "fly-cartridge-state" or header.get("version") != 2:
        raise ValueError("Invalid canonical state header")
    if header.get("metadata") != normalized_metadata(header.get("metadata")):
        raise ValueError("Nonportable state metadata")
    ref_header = {**header, "format": "fly-state-reference", "version": 1}
    old_header = ref.canonical(ref_header)
    compatible = ref.MAGIC + struct.pack("<I", len(old_header)) + old_header + state[start + length:]
    metadata, arrays = ref.decode(compatible, base)
    return metadata, arrays, {field["name"]: field["valueSha256"] for field in header["fields"]}


def shared_locks() -> dict:
    return {
        "graphSha256": file_sha(DATA / "graph.npz"),
        "annotationsSha256": file_sha(DATA / "annotations.feather"),
        "neuronsSha256": file_sha(DATA / "normalized/neurons.feather"),
        "kernelSourceSha256": source_sha(SOURCE),
        "ruleSourceSha256": source_sha(Path(SOURCE).with_name("rule.py")),
        "runtimeSourceTreeSha256": runtime_tree_sha(),
    }


def identity(metadata: dict, fields: dict, locks: dict, settings: dict) -> dict:
    return {"checkpointMetadata": metadata, "locks": locks,
            "fields": fields,
            "publicSettings": settings}


def fixed_probe(metadata: dict, arrays: dict, brain) -> dict:
    with tempfile.TemporaryDirectory() as folder:
        rebuilt = Path(folder) / "reconstructed.npz"
        np.savez_compressed(rebuilt, metadata=json.dumps(metadata), **arrays)
        brain.restore(rebuilt)
        frame = np.full((180, 320, 3), (37, 83, 129), dtype=np.uint8)
        counts, _ = brain.rgb_step(frame, 10.0, learning=not brain.weights_frozen)
        decoder = Decoder(brain.ids, annotations(brain.ids), threshold=3.0)
        action = decoder.decode(counts, 0.01)
        return {"ms": 10, "inputSha256": sha(frame.tobytes()),
                "spikeSha256": sha(counts.tobytes()),
                "memorySha256": brain.memory()["sha256"],
                "action": action["side"], "differenceHz": action["difference_hz"],
                "gateSpikes": action["gate_spikes"], "cursor": brain.cursor}


def export(checkpoint: Path, settings_path: Path, target: Path,
           parent_card_id: str = "0" * 64) -> dict:
    if target.exists():
        raise ValueError("Output directory already exists")
    if not HEX64.fullmatch(parent_card_id):
        raise ValueError("Invalid parent card ID")
    settings = public_settings(json.loads(settings_path.read_text(encoding="utf-8")))
    marker = checkpoint.with_name("service.json")
    if marker.is_file():
        observed_token = json.loads(marker.read_text(encoding="utf-8")).get("tokenAddress")
        if not isinstance(observed_token, str) or observed_token.lower() != settings["tokenAddress"]:
            raise ValueError("Checkpoint token differs from public settings")
    base, brain = ref.baseline()
    state, metadata, fields = state_encode(checkpoint, base, brain)
    decoded_meta, arrays, decoded_fields = state_decode(state, base)
    if decoded_meta != metadata or decoded_fields != fields:
        raise AssertionError("Portable state roundtrip failed")
    locks = shared_locks()
    state_key = sha(DOMAIN + ref.canonical(identity(metadata, fields, locks, settings)))
    manifest = {"format": "fly-cartridge", "formatVersion": 2,
                "neuralStateKey": state_key, "parentCardId": parent_card_id,
                "license": "CC-BY-4.0", "exportedAt": datetime.now(timezone.utc).isoformat(),
                "configCapture": "export-time; historical configuration is not attested",
                "model": metadata["model"], "locks": locks,
                "publicSettings": settings, "state": {"bytes": len(state), "sha256": sha(state)},
                "fieldSha256": fields, "cursor": metadata["cursor"],
                "totalSpikes": metadata["total_spikes"],
                "weightsFrozen": metadata["weights_frozen"],
                "fixedProbe": fixed_probe(metadata, arrays, brain)}
    manifest_bytes = ref.canonical(manifest)
    if len(manifest_bytes) > MAX_MANIFEST:
        raise ValueError("Manifest exceeds 64 KiB limit")
    target.mkdir(parents=True)
    (target / "state.bin").write_bytes(state)
    (target / "cartridge.json").write_bytes(manifest_bytes)
    return {"cardId": sha(manifest_bytes), "neuralStateKey": state_key,
            "stateBytes": len(state), "manifestBytes": len(manifest_bytes),
            "fixedProbe": manifest["fixedProbe"]}


def verify(directory: Path) -> dict:
    state = (directory / "state.bin").read_bytes()
    raw = (directory / "cartridge.json").read_bytes()
    if len(raw) > MAX_MANIFEST:
        raise ValueError("Manifest exceeds limit")
    manifest = json.loads(raw)
    if raw != ref.canonical(manifest) or manifest.get("format") != "fly-cartridge" or manifest.get("formatVersion") != 2:
        raise ValueError("Invalid canonical manifest")
    expected_keys = {"format", "formatVersion", "neuralStateKey", "parentCardId",
                     "license", "exportedAt", "model", "locks", "publicSettings",
                     "state", "fieldSha256", "cursor", "totalSpikes", "weightsFrozen",
                     "fixedProbe", "configCapture"}
    if set(manifest) != expected_keys or manifest["license"] != "CC-BY-4.0" or \
            manifest["configCapture"] != "export-time; historical configuration is not attested" or \
            not HEX64.fullmatch(manifest["parentCardId"]):
        raise ValueError("Unexpected manifest content")
    if manifest["state"] != {"bytes": len(state), "sha256": sha(state)}:
        raise ValueError("State file commitment mismatch")
    if manifest["locks"] != shared_locks():
        raise ValueError("Shared runtime/data locks mismatch")
    settings = public_settings(manifest["publicSettings"])
    base, brain = ref.baseline()
    metadata, arrays, fields = state_decode(state, base)
    if manifest["fieldSha256"] != fields or manifest["model"] != metadata["model"] or \
            manifest["cursor"] != metadata["cursor"] or \
            manifest["totalSpikes"] != metadata["total_spikes"] or \
            manifest["weightsFrozen"] != metadata["weights_frozen"]:
        raise ValueError("Decoded state identity mismatch")
    expected_key = sha(DOMAIN + ref.canonical(identity(metadata, fields, manifest["locks"], settings)))
    if manifest["neuralStateKey"] != expected_key:
        raise ValueError("Neural state key mismatch")
    if manifest["fixedProbe"] != fixed_probe(metadata, arrays, brain):
        raise ValueError("Fixed probe mismatch")
    return {"cardId": sha(raw), "neuralStateKey": expected_key,
            "stateBytes": len(state), "manifestBytes": len(raw),
            "fixedProbe": manifest["fixedProbe"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="command", required=True)
    make = actions.add_parser("export")
    make.add_argument("--checkpoint", type=Path, required=True)
    make.add_argument("--settings-json", type=Path, required=True)
    make.add_argument("--out", type=Path, required=True)
    make.add_argument("--parent-card-id", default="0" * 64)
    check = actions.add_parser("verify")
    check.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = export(args.checkpoint, args.settings_json, args.out, args.parent_card_id) \
        if args.command == "export" else verify(args.directory)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
