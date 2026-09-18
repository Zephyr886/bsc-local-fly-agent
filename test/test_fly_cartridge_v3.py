"""Trait wire format and fresh-boot boundary checks."""
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fly_cartridge_state_ref as ref  # noqa: E402
import fly_cartridge_v3 as v3  # noqa: E402


class TraitCartridgeTests(unittest.TestCase):
    def setUp(self):
        self.base = {
            "memory_u": np.zeros(3, dtype=np.float64),
            "memory_w": np.zeros(3, dtype=np.float64),
            "weight": np.array([1, 2, 3, 4], dtype=np.float32),
        }
        self.values = {
            "memory_u": np.array([0, -0.0, 0.25], dtype=np.float64),
            "memory_w": np.array([0.1, 0, -0.0], dtype=np.float64),
            "weight": np.array([1, 2.5, 3, 4], dtype=np.float32),
        }

    def test_roundtrip_preserves_exact_float_bits(self):
        blob = v3.encode_arrays(self.values, self.base)
        restored = v3.decode_arrays(blob, self.base)
        for name in v3.FIELDS:
            self.assertEqual(ref._array_bytes(restored[name]), ref._array_bytes(self.values[name]))

    def test_rejects_corruption_and_wrong_baseline(self):
        blob = v3.encode_arrays(self.values, self.base)
        with self.assertRaises(ValueError):
            v3.decode_arrays(blob[:-1] + bytes([blob[-1] ^ 1]), self.base)
        wrong = {**self.base, "weight": np.zeros(4, dtype=np.float32)}
        with self.assertRaises(ValueError):
            v3.decode_arrays(blob, wrong)
        with self.assertRaises(ValueError):
            v3.decode_arrays(blob[:-1], self.base)

    def test_trait_key_excludes_game_session(self):
        first = v3.trait_key(self.values, {"graphSha256": "a" * 64})
        changed = {**self.values, "memory_w": self.values["memory_w"].copy()}
        changed["memory_w"][0] = 0.2
        self.assertNotEqual(first, v3.trait_key(changed, {"graphSha256": "a" * 64}))
        self.assertNotEqual(first, v3.trait_key(self.values, {"graphSha256": "b" * 64}))

    def test_install_refuses_existing_device_run(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "existing"
            target.mkdir()
            sentinel = target / "service.npz"
            sentinel.write_bytes(b"existing-game-progress")
            with self.assertRaisesRegex(ValueError, "already exists"):
                v3.install(Path(folder) / "missing-card", target, "0x" + "1" * 40)
            self.assertEqual(sentinel.read_bytes(), b"existing-game-progress")
            with self.assertRaisesRegex(ValueError, "nonzero token"):
                v3.install(Path(folder) / "missing-card", Path(folder) / "fresh", "0x" + "0" * 40)

    def test_legacy_file_locks_require_exact_historical_hashes(self):
        stable = {"locksVersion": 2, "graphArraysSha256": "a" * 64,
                  "neuronTransmittersSha256": "b" * 64,
                  "annotationsSha256": "c" * 64, "kernelSourceSha256": "d" * 64,
                  "ruleSourceSha256": "e" * 64, "runtimeSourceTreeSha256": "f" * 64}
        legacy = {key: stable[key] for key in ("annotationsSha256", "kernelSourceSha256",
                  "ruleSourceSha256", "runtimeSourceTreeSha256")}
        legacy.update(graphSha256=v3.LEGACY_GRAPH_SHA256,
                      neuronsSha256=v3.LEGACY_NEURONS_SHA256)
        with patch.object(v3, "shared_locks", return_value=stable):
            self.assertTrue(v3.locks_compatible(stable))
            self.assertTrue(v3.locks_compatible(legacy))
            self.assertFalse(v3.locks_compatible({**legacy, "graphSha256": "0" * 64}))
            self.assertFalse(v3.locks_compatible({**stable, "extra": 1}))


if __name__ == "__main__":
    unittest.main()
