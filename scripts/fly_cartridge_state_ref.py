"""Experimental, lossless Fly cartridge state codec. Not a public wire format.

Run only on local checkpoints. No network, wallet, settings DB or pickle access.
The baseline is freshly constructed from the locked local graph and sources.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import zlib

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/stonkfly"))
os.environ.setdefault("STONKFLY_DATA", str(ROOT / "data/full-brain"))
from stonkfly.neural.visual import VisualMemoryBrain  # noqa: E402
from stonkfly.neural.brain import compatible_build_provenance  # noqa: E402
from stonkfly.neural.controller import Decoder  # noqa: E402
from stonkfly.neural.common import annotations  # noqa: E402

MAGIC = b"FLY-STATE-REF-1\n"
MAX_HEADER = 64 * 1024
MAX_PAYLOAD = 180 * 1024 * 1024
MAX_FIELDS = 64


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False) + "\n").encode()


def baseline():
    brain = VisualMemoryBrain()
    names = ["weight", *brain.fields]
    return {name: np.ascontiguousarray(brain.initial[name] if name in brain.initial
                                       else getattr(brain, name)).copy() for name in names}, brain


def _array_bytes(array: np.ndarray) -> bytes:
    if array.dtype.kind not in "fiub" or not array.dtype.isnative:
        raise ValueError("Unsafe or non-native checkpoint dtype")
    if array.dtype.kind == "f" and not np.isfinite(array).all():
        raise ValueError("Nonfinite checkpoint array")
    return np.ascontiguousarray(array).tobytes()


def _checkpoint(path: Path, expected: set[str]):
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Checkpoint too large")
    with np.load(path, allow_pickle=False) as src:
        if set(src.files) != expected | {"metadata"}:
            raise ValueError("Missing or unexpected checkpoint field")
        meta = src["metadata"]
        if meta.shape != () or meta.dtype.kind not in "US":
            raise ValueError("Invalid checkpoint metadata")
        metadata = json.loads(str(meta))
        arrays = {name: src[name].copy() for name in expected}
    return metadata, arrays


def encode(path: Path, base: dict[str, np.ndarray], brain):
    metadata, arrays = _checkpoint(path, set(base))
    if (metadata.get("model") != "stonkfly-dual-compartment-v1" or
            metadata.get("configuration_sha256", {}).get("initial_weight") !=
            digest(_array_bytes(base["weight"]))):
        raise ValueError("Checkpoint baseline/model mismatch")
    fields = []
    payload = bytearray()
    for name in sorted(base):
        value, original = arrays[name], base[name]
        if value.dtype != original.dtype or value.shape != original.shape:
            raise ValueError(f"Checkpoint schema mismatch: {name}")
        raw = _array_bytes(value)
        default = _array_bytes(original)
        # Element comparisons use raw bytes, preserving signed zero and float bits.
        width = value.dtype.itemsize
        current_rows = np.frombuffer(raw, dtype=f"V{width}")
        default_rows = np.frombuffer(default, dtype=f"V{width}")
        indexes = np.flatnonzero(current_rows != default_rows)
        sparse = indexes.astype("<u4").tobytes() + raw_rows(raw, indexes, width)
        full_compressed = zlib.compress(raw, 9)
        sparse_compressed = zlib.compress(sparse, 9)
        if len(sparse_compressed) < len(full_compressed):
            mode, encoded = "sparse-u32", sparse_compressed
        else:
            mode, encoded = "full", full_compressed
        fields.append({"name": name, "dtype": value.dtype.str,
                       "shape": list(value.shape), "baseSha256": digest(default),
                       "valueSha256": digest(raw), "mode": mode,
                       "changed": int(len(indexes)), "offset": len(payload),
                       "length": len(encoded), "uncompressed": len(sparse) if mode == "sparse-u32" else len(raw),
                       "payloadSha256": digest(encoded)})
        payload.extend(encoded)
    header = {"format": "fly-state-reference", "version": 1,
              "metadata": metadata, "fields": fields,
              "payloadSha256": digest(payload)}
    heading = canonical(header)
    if len(heading) > MAX_HEADER or len(payload) > MAX_PAYLOAD:
        raise ValueError("Reference cartridge size limit exceeded")
    return MAGIC + struct.pack("<I", len(heading)) + heading + payload, fields


def raw_rows(raw: bytes, indexes: np.ndarray, width: int) -> bytes:
    rows = np.frombuffer(raw, dtype=f"V{width}")
    return rows[indexes].tobytes()


def decode(blob: bytes, base: dict[str, np.ndarray]):
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 4:
        raise ValueError("Invalid reference cartridge magic")
    length = struct.unpack_from("<I", blob, len(MAGIC))[0]
    if length > MAX_HEADER or len(blob) < len(MAGIC) + 4 + length:
        raise ValueError("Invalid reference header size")
    heading = blob[len(MAGIC) + 4:len(MAGIC) + 4 + length]
    header = json.loads(heading)
    if heading != canonical(header) or header.get("format") != "fly-state-reference" or header.get("version") != 1:
        raise ValueError("Invalid reference header")
    payload = blob[len(MAGIC) + 4 + length:]
    fields = header.get("fields")
    if (not isinstance(fields, list) or len(fields) > MAX_FIELDS or
            [x.get("name") for x in fields] != sorted(base) or
            len(payload) > MAX_PAYLOAD or digest(payload) != header.get("payloadSha256")):
        raise ValueError("Invalid reference field table or payload")
    arrays = {}
    offset = 0
    for field in fields:
        name = field["name"]
        original = base[name]
        width = original.dtype.itemsize
        default = _array_bytes(original)
        count = original.size
        if (field["dtype"] != original.dtype.str or field["shape"] != list(original.shape) or
                field["baseSha256"] != digest(default) or field["offset"] != offset or
                not isinstance(field["length"], int) or field["length"] < 0):
            raise ValueError(f"Reference schema/baseline mismatch: {name}")
        end = offset + field["length"]
        if end > len(payload):
            raise ValueError("Truncated reference payload")
        encoded = payload[offset:end]
        offset = end
        if digest(encoded) != field["payloadSha256"]:
            raise ValueError("Corrupt field payload")
        mode = field["mode"]
        if mode not in ("full", "sparse-u32"):
            raise ValueError("Unknown field encoding")
        expected_size = count * width if mode == "full" else field["changed"] * (4 + width)
        if expected_size != field["uncompressed"] or expected_size > MAX_PAYLOAD:
            raise ValueError("Invalid field expansion length")
        inflater = zlib.decompressobj()
        data = inflater.decompress(encoded, expected_size + 1)
        if len(data) != expected_size or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError("Invalid compressed field")
        if mode == "sparse-u32":
            changed = field["changed"]
            indexes = np.frombuffer(data[:changed * 4], dtype="<u4")
            if (changed > count or (changed and (indexes[-1] >= count or
                  np.any(indexes[1:] <= indexes[:-1])))):
                raise ValueError("Invalid sparse indexes")
            result = np.frombuffer(default, dtype=f"V{width}").copy()
            result[indexes] = np.frombuffer(data[changed * 4:], dtype=f"V{width}")
            raw = result.tobytes()
        else:
            raw = data
        if digest(raw) != field["valueSha256"]:
            raise ValueError("Decoded field hash mismatch")
        arrays[name] = np.frombuffer(raw, dtype=original.dtype).reshape(original.shape).copy()
    if offset != len(payload):
        raise ValueError("Trailing reference payload")
    return header["metadata"], arrays


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoints", nargs="*", type=Path)
    parser.add_argument("--out", type=Path, help="Write JSON audit report only")
    parser.add_argument("--write-bin", type=Path,
                        help="Write one experimental binary for the single checkpoint")
    parser.add_argument("--read-bin", type=Path,
                        help="Decode an experimental binary against this local baseline")
    parser.add_argument("--compare-checkpoint", type=Path,
                        help="When reading binary, compare every decoded field with this NPZ")
    parser.add_argument("--continue-ms", type=float, default=0,
                        help="For compatible checkpoints, compare one further RGB/learning step")
    parser.add_argument("--state-digests", action="store_true",
                        help="With --read-bin --continue-ms, report every post-step field hash")
    parser.add_argument("--write-post-checkpoint", type=Path,
                        help="With --read-bin --continue-ms, save the post-step NPZ for comparison")
    args = parser.parse_args()
    if args.continue_ms < 0 or args.continue_ms > 1000:
        parser.error("--continue-ms must be 0..1000")
    if args.state_digests and (not args.read_bin or not args.continue_ms):
        parser.error("--state-digests requires --read-bin and --continue-ms")
    if args.write_post_checkpoint and (not args.read_bin or not args.continue_ms):
        parser.error("--write-post-checkpoint requires --read-bin and --continue-ms")
    if args.read_bin:
        if args.checkpoints or args.write_bin:
            parser.error("--read-bin cannot be combined with checkpoint encoding options")
    elif not args.checkpoints or (args.write_bin and len(args.checkpoints) != 1) or args.compare_checkpoint:
        parser.error("supply checkpoints, or --read-bin with optional --compare-checkpoint")
    started = time.perf_counter()
    base, brain = baseline()
    if args.read_bin:
        metadata, arrays = decode(args.read_bin.read_bytes(), base)
        if args.compare_checkpoint:
            expected_meta, expected_arrays = _checkpoint(args.compare_checkpoint, set(base))
            if metadata != expected_meta or any(_array_bytes(arrays[k]) != _array_bytes(expected_arrays[k]) for k in base):
                raise AssertionError("Decoded binary differs from checkpoint")
        report = {"status": "experimental-binary-verified", "binary": str(args.read_bin),
                  "bytes": args.read_bin.stat().st_size,
                  "model": metadata["model"], "cursor": metadata["cursor"],
                  "runtimeSourceCompatible": compatible_build_provenance(metadata["build"], brain.build),
                  "fields": len(arrays), "comparedCheckpoint": str(args.compare_checkpoint) if args.compare_checkpoint else None}
        if args.continue_ms:
            if not report["runtimeSourceCompatible"]:
                raise ValueError("Cannot probe with incompatible kernel source")
            with tempfile.TemporaryDirectory() as folder:
                rebuilt = Path(folder) / "reconstructed.npz"
                np.savez_compressed(rebuilt, metadata=json.dumps(metadata), **arrays)
                brain.restore(rebuilt)
                frame = np.full((180, 320, 3), (37, 83, 129), dtype=np.uint8)
                counts, _ = brain.rgb_step(frame, args.continue_ms,
                                           learning=not brain.weights_frozen)
                decoder = Decoder(brain.ids, annotations(brain.ids), threshold=3.0)
                action = decoder.decode(counts, args.continue_ms / 1000)
                report["probe"] = {
                    "ms": args.continue_ms, "inputSha256": digest(frame.tobytes()),
                    "spikeSha256": digest(counts.tobytes()),
                    "memorySha256": brain.memory()["sha256"],
                    "action": action["side"], "differenceHz": action["difference_hz"],
                    "gateSpikes": action["gate_spikes"],
                    "cursor": brain.cursor,
                }
                if args.state_digests:
                    report["probe"]["totalSpikes"] = brain.total_spikes
                    report["probe"]["weightsFrozen"] = brain.weights_frozen
                    report["probe"]["fieldSha256"] = {
                        name: digest(_array_bytes(getattr(brain, name)))
                        for name in sorted(base)
                    }
                if args.write_post_checkpoint:
                    brain.checkpoint(args.write_post_checkpoint)
        data = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(data, encoding="utf-8")
        print(data)
        return
    results = []
    for path in args.checkpoints:
        t = time.perf_counter()
        blob, fields = encode(path, base, brain)
        metadata, arrays = decode(blob, base)
        source_meta, source_arrays = _checkpoint(path, set(base))
        if metadata != source_meta or any(_array_bytes(arrays[k]) != _array_bytes(source_arrays[k]) for k in base):
            raise AssertionError(f"Roundtrip mismatch: {path}")
        source_hash = metadata["build"]["source_sha256"]
        source_compatible = compatible_build_provenance(metadata["build"], brain.build)
        if args.write_bin:
            if not source_compatible:
                raise ValueError("Cannot export state with incompatible kernel source")
            args.write_bin.parent.mkdir(parents=True, exist_ok=True)
            args.write_bin.write_bytes(blob)
        continuation = "not-requested"
        if args.continue_ms:
            if not source_compatible:
                continuation = "blocked-source-version-mismatch"
            else:
                frame = np.full((180, 320, 3), (37, 83, 129), dtype=np.uint8)
                with tempfile.TemporaryDirectory() as folder:
                    rebuilt = Path(folder) / "reconstructed.npz"
                    np.savez_compressed(rebuilt, metadata=json.dumps(metadata), **arrays)
                    outcomes = []
                    for candidate in (path, rebuilt):
                        brain.restore(candidate)
                        counts, _ = brain.rgb_step(frame, args.continue_ms, learning=True)
                        outcomes.append((digest(counts.tobytes()), brain.cursor,
                                         brain.total_spikes,
                                         {name: digest(_array_bytes(getattr(brain, name)))
                                          for name in base}))
                    if outcomes[0] != outcomes[1]:
                        raise AssertionError(f"Continuation mismatch: {path}")
                    continuation = "bitwise-matched"
        results.append({"checkpoint": str(path), "checkpointBytes": path.stat().st_size,
                        "referenceBytes": len(blob), "ratio": round(len(blob) / path.stat().st_size, 5),
                        "roundtripSeconds": round(time.perf_counter() - t, 3),
                        "sourceSha256": source_hash,
                        "runtimeSourceMatches": source_hash == brain.build["source_sha256"],
                        "runtimeSourceCompatible": source_compatible,
                        "continuation": continuation,
                        "cursor": metadata["cursor"], "weightsFrozen": metadata["weights_frozen"],
                        "fields": {f["name"]: {"changed": f["changed"], "mode": f["mode"],
                                               "bytes": f["length"]} for f in fields}})
    report = {"status": "reference-array-roundtrip-only", "os": sys.platform,
              "python": sys.version.split()[0], "numpy": np.__version__,
              "runtimeSourceSha256": brain.build["source_sha256"],
              "baselineSeconds": round(time.perf_counter() - started, 3), "samples": results}
    data = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(data, encoding="utf-8")
    print(data)


if __name__ == "__main__":
    main()
