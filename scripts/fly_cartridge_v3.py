"""Experimental learned-trait cartridge: no session or neural run position.

The v2 checkpoint format remains unchanged. This module deliberately uses a
new domain and format version because booting a trait is not checkpoint resume.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import zlib

import numpy as np

import fly_cartridge_state_ref as ref
import fly_cartridge_v2 as v2

MAGIC = b"FLY-CARTRIDGE-TRAIT-3\n"
DOMAIN = b"FlyCartridge/v3/trait\0"
FIELDS = ("memory_u", "memory_w", "weight")
MAX_STATE = 262_144
MAX_MANIFEST = 16_384
CHUNK_BYTES = 24_576


def encode_arrays(arrays: dict, base: dict) -> bytes:
    if set(arrays) != set(FIELDS) or set(base) != set(FIELDS):
        raise ValueError("Trait fields must be memory_u, memory_w and weight")
    payload = bytearray()
    fields = []
    for name in FIELDS:
        value, original = arrays[name], base[name]
        if value.shape != original.shape or value.dtype != original.dtype:
            raise ValueError(f"Trait schema mismatch: {name}")
        raw, default = ref._array_bytes(value), ref._array_bytes(original)
        width = value.dtype.itemsize
        indexes = np.flatnonzero(np.frombuffer(raw, dtype=f"V{width}") !=
                                   np.frombuffer(default, dtype=f"V{width}"))
        sparse = indexes.astype("<u4").tobytes() + ref.raw_rows(raw, indexes, width)
        full_encoded = zlib.compress(raw, 9)
        sparse_encoded = zlib.compress(sparse, 9)
        mode, encoded = (("sparse-u32", sparse_encoded) if len(sparse_encoded) < len(full_encoded)
                         else ("full", full_encoded))
        fields.append({"name": name, "dtype": value.dtype.str, "shape": list(value.shape),
                       "baseSha256": ref.digest(default), "valueSha256": ref.digest(raw),
                       "mode": mode, "changed": int(len(indexes)), "offset": len(payload),
                       "length": len(encoded), "uncompressed": len(sparse) if mode == "sparse-u32" else len(raw),
                       "payloadSha256": ref.digest(encoded)})
        payload.extend(encoded)
    header = {"format": "fly-cartridge-trait", "version": 3, "fields": fields,
              "payloadSha256": ref.digest(payload)}
    raw_header = ref.canonical(header)
    result = MAGIC + struct.pack("<I", len(raw_header)) + raw_header + payload
    if len(raw_header) > ref.MAX_HEADER or len(result) > MAX_STATE:
        raise ValueError("Trait cartridge exceeds size limit")
    return result


def decode_arrays(state: bytes, base: dict) -> dict:
    if not state.startswith(MAGIC) or len(state) > MAX_STATE or len(state) < len(MAGIC) + 4:
        raise ValueError("Invalid trait state")
    header_length = struct.unpack_from("<I", state, len(MAGIC))[0]
    start = len(MAGIC) + 4
    if header_length > ref.MAX_HEADER or start + header_length > len(state):
        raise ValueError("Invalid trait header length")
    header_raw = state[start:start + header_length]
    header = json.loads(header_raw)
    if header_raw != ref.canonical(header) or header.get("format") != "fly-cartridge-trait" or header.get("version") != 3:
        raise ValueError("Invalid trait header")
    fields = header.get("fields")
    if not isinstance(fields, list) or [item.get("name") for item in fields] != list(FIELDS):
        raise ValueError("Invalid trait field table")
    # Reuse the bounded, hashed v2 reference decoder after validating the new
    # envelope. It performs schema, baseline, compressed-size and index checks.
    reference = {**header, "format": "fly-state-reference", "version": 1,
                 "metadata": {}}
    reference_header = ref.canonical(reference)
    blob = ref.MAGIC + struct.pack("<I", len(reference_header)) + reference_header + state[start + header_length:]
    _, arrays = ref.decode(blob, base)
    return arrays


def trait_key(arrays: dict, locks: dict) -> str:
    fields = {name: ref.digest(ref._array_bytes(arrays[name])) for name in FIELDS}
    return v2.sha(DOMAIN + ref.canonical({"fields": fields, "locks": locks,
                                        "boot": "fresh-neural-state;learning-enabled"}))


def boot(brain, arrays: dict) -> None:
    brain.reset()
    for name in FIELDS:
        getattr(brain, name)[:] = arrays[name]
    brain.weights_frozen = False


def probe(brain, arrays: dict) -> dict:
    boot(brain, arrays)
    before = brain.memory()["sha256"]
    image = np.full((180, 320, 3), (37, 83, 129), dtype=np.uint8)
    counts, _ = brain.rgb_step(image, 10.0, learning=True)
    return {"inputSha256": v2.sha(image.tobytes()), "initialMemorySha256": before,
            "spikeSha256": v2.sha(counts.tobytes()),
            "postMemorySha256": brain.memory()["sha256"], "cursor": brain.cursor}


def export(checkpoint: Path, target: Path) -> dict:
    if target.exists():
        raise ValueError("Output directory already exists")
    base_all, brain = ref.baseline()
    brain.restore(checkpoint)  # Full source and model provenance check.
    arrays = {name: getattr(brain, name).copy() for name in FIELDS}
    base = {name: base_all[name] for name in FIELDS}
    state = encode_arrays(arrays, base)
    if any(ref._array_bytes(decoded) != ref._array_bytes(arrays[name])
           for name, decoded in decode_arrays(state, base).items()):
        raise AssertionError("Trait roundtrip failed")
    locks = v2.shared_locks()
    manifest = {"format": "fly-cartridge", "formatVersion": 3,
                "semantics": "learned-trait;fresh-neural-boot;learning-enabled",
                "model": "stonkfly-dual-compartment-v1", "locks": locks,
                "traitKey": trait_key(arrays, locks),
                "fieldSha256": {name: ref.digest(ref._array_bytes(arrays[name])) for name in FIELDS},
                "state": {"bytes": len(state), "sha256": v2.sha(state)},
                "fixedBootProbe": probe(brain, arrays)}
    raw = ref.canonical(manifest)
    if len(raw) > MAX_MANIFEST:
        raise ValueError("Trait manifest exceeds size limit")
    target.mkdir(parents=True)
    (target / "state.bin").write_bytes(state)
    (target / "cartridge.json").write_bytes(raw)
    return {"cardId": v2.sha(raw), "traitKey": manifest["traitKey"],
            "stateBytes": len(state), "manifestBytes": len(raw),
            "estimatedChunks": (len(state) + CHUNK_BYTES - 1) // CHUNK_BYTES,
            "fixedBootProbe": manifest["fixedBootProbe"]}


def verify(directory: Path, boot_checkpoint: Path | None = None) -> dict:
    raw = (directory / "cartridge.json").read_bytes()
    state = (directory / "state.bin").read_bytes()
    if len(raw) > MAX_MANIFEST or len(state) > MAX_STATE:
        raise ValueError("Trait cartridge exceeds size limit")
    manifest = json.loads(raw)
    if raw != ref.canonical(manifest) or set(manifest) != {"format", "formatVersion", "semantics", "model", "locks", "traitKey", "fieldSha256", "state", "fixedBootProbe"} or \
            manifest["format"] != "fly-cartridge" or manifest["formatVersion"] != 3 or \
            manifest["semantics"] != "learned-trait;fresh-neural-boot;learning-enabled" or \
            manifest["model"] != "stonkfly-dual-compartment-v1":
        raise ValueError("Invalid trait manifest")
    if manifest["state"] != {"bytes": len(state), "sha256": v2.sha(state)} or manifest["locks"] != v2.shared_locks():
        raise ValueError("Trait commitment or shared runtime mismatch")
    base_all, brain = ref.baseline()
    arrays = decode_arrays(state, {name: base_all[name] for name in FIELDS})
    field_hashes = {name: ref.digest(ref._array_bytes(arrays[name])) for name in FIELDS}
    if manifest["fieldSha256"] != field_hashes or manifest["traitKey"] != trait_key(arrays, manifest["locks"]):
        raise ValueError("Trait identity mismatch")
    if manifest["fixedBootProbe"] != probe(brain, arrays):
        raise ValueError("Trait boot probe mismatch")
    if boot_checkpoint is not None:
        if boot_checkpoint.exists():
            raise ValueError("Boot checkpoint already exists")
        boot(brain, arrays)
        brain.checkpoint(boot_checkpoint)
    return {"cardId": v2.sha(raw), "traitKey": manifest["traitKey"],
            "stateBytes": len(state), "manifestBytes": len(raw),
            "estimatedChunks": (len(state) + CHUNK_BYTES - 1) // CHUNK_BYTES,
            "fixedBootProbe": manifest["fixedBootProbe"]}


def install(directory: Path, target: Path, token_address: str) -> dict:
    """Create a new device-owned run; never overwrite an existing session."""
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", token_address) or int(token_address, 16) == 0:
        raise ValueError("A nonzero token address is required")
    if target.exists():
        raise ValueError("Device run directory already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fly-trait-", dir=target.parent) as temporary:
        staged = Path(temporary) / "run"
        staged.mkdir()
        result = verify(directory, staged / "service.npz")
        marker = {"tokenAddress": token_address.lower(),
                  "cartridgeId": result["cardId"], "sourceFormatVersion": 3}
        (staged / "service.json").write_bytes(ref.canonical(marker))
        if target.exists():
            raise ValueError("Device run directory already exists")
        os.rename(staged, target)
    return {**result, "deviceCheckpoint": str(target / "service.npz"),
            "deviceMarker": str(target / "service.json"),
            "tokenAddress": token_address.lower()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("export")
    make.add_argument("--checkpoint", type=Path, required=True)
    make.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("directory", type=Path)
    check.add_argument("--boot-checkpoint", type=Path)
    load = commands.add_parser("install", help="Create a new local run from a v3 trait")
    load.add_argument("directory", type=Path)
    load.add_argument("--out", type=Path, required=True,
                      help="New device-run directory; existing paths are refused")
    load.add_argument("--token-address", required=True,
                      help="Deployment token chosen by this device; never written to the cartridge")
    args = parser.parse_args()
    result = (export(args.checkpoint, args.out) if args.command == "export"
              else install(args.directory, args.out, args.token_address)
              if args.command == "install" else verify(args.directory, args.boot_checkpoint))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
