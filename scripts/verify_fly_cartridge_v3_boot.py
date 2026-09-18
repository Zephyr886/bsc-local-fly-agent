"""Check that an installed v3 cartridge starts and learns in a real controller."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

import fly_cartridge_state_ref as ref  # Establish locked local runtime path.
from stonkfly.config import Settings
from stonkfly.neural.controller import FlyController


def check(cartridge: Path, device: Path) -> dict:
    manifest = json.loads((cartridge / "cartridge.json").read_bytes())
    marker = json.loads((device / "service.json").read_bytes())
    expected_card_id = hashlib.sha256((cartridge / "cartridge.json").read_bytes()).hexdigest()
    if marker.get("cartridgeId") != expected_card_id or marker.get("sourceFormatVersion") != 3:
        raise ValueError("Device marker does not match cartridge")
    controller = FlyController(Settings())
    controller.restore(device / "service.npz")
    brain = controller.brain
    if brain.cursor != 0 or brain.weights_frozen:
        raise ValueError("Device did not start a fresh learning run")
    before = brain.memory()["sha256"]
    image = np.full((180, 320, 3), (37, 83, 129), dtype=np.uint8)
    counts, _ = brain.rgb_step(image, 10.0, learning=True)
    after = brain.memory()["sha256"]
    probe = manifest["fixedBootProbe"]
    if (before != probe["initialMemorySha256"] or
            hashlib.sha256(counts.tobytes()).hexdigest() != probe["spikeSha256"] or
            after != probe["postMemorySha256"] or brain.cursor != probe["cursor"]):
        raise ValueError("Installed controller boot probe mismatch")
    return {"cardId": expected_card_id, "initialCursor": 0,
            "postCursor": brain.cursor, "initialMemorySha256": before,
            "postMemorySha256": after, "learningEnabled": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cartridge", type=Path)
    parser.add_argument("device", type=Path)
    args = parser.parse_args()
    print(json.dumps(check(args.cartridge, args.device), indent=2))
