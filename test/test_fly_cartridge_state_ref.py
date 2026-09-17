"""Small adversarial checks for the internal lossless reference codec."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

MODULE = Path(__file__).resolve().parents[1] / "scripts/fly_cartridge_state_ref.py"
spec = importlib.util.spec_from_file_location("state_ref", MODULE)
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)


class ReferenceCodecTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "test.npz"
        self.base = {"weight": np.array([0.0, -0.0, 1.0], dtype=np.float32),
                     "trace": np.zeros(4, dtype=np.float64)}
        self.meta = {"model": "stonkfly-dual-compartment-v1",
                     "configuration_sha256": {"initial_weight":
                                              codec.digest(self.base["weight"].tobytes())}}
        np.savez_compressed(self.path, metadata=json.dumps(self.meta),
                            weight=np.array([-0.0, 0.0, 1.0], dtype=np.float32),
                            trace=np.array([0, 1, 0, 2], dtype=np.float64))

    def test_bitwise_roundtrip_including_signed_zero(self):
        blob, fields = codec.encode(self.path, self.base, None)
        meta, arrays = codec.decode(blob, self.base)
        self.assertEqual(meta, self.meta)
        with np.load(self.path) as source:
            for name in self.base:
                self.assertEqual(arrays[name].tobytes(), source[name].tobytes())
        self.assertEqual(next(f for f in fields if f["name"] == "weight")["changed"], 2)

    def test_corrupt_payload_and_wrong_baseline_rejected(self):
        blob, _ = codec.encode(self.path, self.base, None)
        with self.assertRaises(ValueError):
            codec.decode(blob[:-1] + bytes([blob[-1] ^ 1]), self.base)
        wrong = dict(self.base)
        wrong["weight"] = np.ones(3, dtype=np.float32)
        with self.assertRaises(ValueError):
            codec.decode(blob, wrong)

    def test_nonfinite_and_unknown_field_rejected(self):
        np.savez_compressed(self.path, metadata=json.dumps(self.meta),
                            weight=np.array([1, np.nan, 2], dtype=np.float32),
                            trace=self.base["trace"])
        with self.assertRaisesRegex(ValueError, "Nonfinite"):
            codec.encode(self.path, self.base, None)
        np.savez_compressed(self.path, metadata=json.dumps(self.meta),
                            weight=self.base["weight"], trace=self.base["trace"],
                            private_key=np.array([1]))
        with self.assertRaisesRegex(ValueError, "unexpected checkpoint field"):
            codec.encode(self.path, self.base, None)

    def test_kernel_provenance_accepts_only_line_ending_variants(self):
        from stonkfly.neural.brain import SOURCE, compatible_build_provenance
        canonical = SOURCE.read_bytes().replace(b"\r\n", b"\n")
        lf = hashlib.sha256(canonical).hexdigest()
        crlf = hashlib.sha256(canonical.replace(b"\n", b"\r\n")).hexdigest()
        current = {"model": "stonkfly-dual-compartment-v1", "source_sha256": lf}
        self.assertTrue(compatible_build_provenance({**current, "source_sha256": crlf}, current))
        self.assertFalse(compatible_build_provenance({**current, "source_sha256": "0" * 64}, current))
        self.assertFalse(compatible_build_provenance({**current, "source_sha256": []}, current))

    def test_rule_provenance_accepts_only_line_ending_variants(self):
        from stonkfly.neural.brain import compatible_configuration_signature
        rule = MODULE.parents[1] / "vendor/stonkfly/stonkfly/neural/rule.py"
        canonical = rule.read_bytes().replace(b"\r\n", b"\n")
        lf = hashlib.sha256(canonical).hexdigest()
        crlf = hashlib.sha256(canonical.replace(b"\n", b"\r\n")).hexdigest()
        current = {"initial_weight": "same", "rule_sha256": lf}
        self.assertTrue(compatible_configuration_signature(
            {**current, "rule_sha256": crlf}, current))
        self.assertFalse(compatible_configuration_signature(
            {**current, "rule_sha256": "0" * 64}, current))
        self.assertFalse(compatible_configuration_signature(
            {**current, "rule_sha256": []}, current))
        self.assertFalse(compatible_configuration_signature(
            {**current, "initial_weight": "wrong"}, current))


if __name__ == "__main__":
    unittest.main()
