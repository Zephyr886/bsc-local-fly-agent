"""Fly Cartridge v4 canonical Profile, trait and provenance tests."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fly_cartridge_state_ref as ref  # noqa: E402
import fly_cartridge_v2 as v2  # noqa: E402
import fly_cartridge_v3 as v3  # noqa: E402
import fly_cartridge_v4 as v4  # noqa: E402


class FakeBrain:
    def __init__(self, arrays):
        for name, value in arrays.items():
            setattr(self, name, value.copy())
        self.cursor = 0
        self.weights_frozen = False

    def reset(self):
        self.cursor = 0

    def checkpoint(self, path):
        path.write_bytes(b"v4-checkpoint")


class CartridgeV4Tests(unittest.TestCase):
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
        self.spec = json.loads(
            (ROOT / "src/profile/presets/balanced-v1.json").read_text(encoding="utf-8")
        )["spec"]
        self.fly_id = "11111111-1111-4111-8111-111111111111"
        self.locks = {"fixtureLock": "0" * 64}
        self.probe = {"fixture": "fresh-boot-only"}

    def profile(self, spec=None, revision=7):
        value = copy.deepcopy(spec or self.spec)
        return {
            "apiVersion": "flap.ai/v1", "kind": "FlyProfile",
            "metadata": {
                "flyId": self.fly_id, "revision": revision, "name": "Fixture Fly",
                "description": "", "tags": ["fixture"],
                "createdAt": "2026-09-20T00:00:00.000Z",
                "updatedAt": "2026-09-20T00:00:00.000Z",
                "profileHash": v4.profile_hash(value),
            },
            "spec": value,
        }

    def cartridge(self, root, profile=None, lineage=None, provenance=None):
        state = v3.encode_arrays(self.values, self.base)
        manifest = v4.build_manifest(
            profile_document=profile or self.profile(), arrays=self.values, state=state,
            locks=self.locks, fixed_boot_probe=self.probe,
            training={"runId": None, "completedAt": None, "datasetHash": None},
            lineage=lineage, provenance=provenance,
        )
        root.mkdir()
        (root / "cartridge.json").write_bytes(v4.canonical_manifest(manifest))
        (root / "state.bin").write_bytes(state)
        return manifest, state

    def verify_patches(self):
        return patch.multiple(v4.v3,
                              locks_compatible=lambda locks: locks == self.locks,
                              probe=lambda brain, arrays: self.probe)

    def test_profile_canonical_hash_matches_node_vector(self):
        self.assertEqual(v4.profile_hash(self.spec),
                         "sha256:d87557af0d8babf6828f1b8ba9154410a83a7335d3644ddc727a90420f49e132")
        self.assertEqual(v4.canonical_json({"z": 1.0, "a": "果蝇"}), '{"a":"果蝇","z":1}')

    def test_v4_roundtrip_keeps_v3_state_bytes_and_installs_fresh_checkpoint(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cartridge = root / "card"
            manifest, state = self.cartridge(cartridge)
            brain = FakeBrain(self.base)
            with self.verify_patches(), patch.object(v4.ref, "baseline", return_value=(self.base, brain)):
                result = v4.verify(cartridge)
                installed = v4.install(cartridge, root / "installed")
            self.assertEqual((cartridge / "state.bin").read_bytes(), state)
            self.assertEqual(result["profileHash"], manifest["fly"]["profileHash"])
            self.assertEqual(result["cardId"], v2.sha(v4.canonical_manifest(manifest)))
            self.assertTrue((root / "installed/service.npz").is_file())
            marker = json.loads((root / "installed/service.json").read_bytes())
            self.assertEqual(marker["flyId"], self.fly_id)
            self.assertEqual(marker["profileRevision"], 7)
            self.assertEqual(installed["provenance"]["sourceFormatVersion"], 4)

    def test_profile_change_changes_profile_and_card_not_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first_dir, second_dir = root / "first", root / "second"
            first, state = self.cartridge(first_dir)
            changed = copy.deepcopy(self.spec)
            changed["strategy"]["buyPercent"] = 3
            second, second_state = self.cartridge(second_dir, self.profile(changed))
            self.assertNotEqual(first["fly"]["profileHash"], second["fly"]["profileHash"])
            self.assertNotEqual(v2.sha(v4.canonical_manifest(first)),
                                v2.sha(v4.canonical_manifest(second)))
            self.assertEqual(first["state"]["sha256"], second["state"]["sha256"])
            self.assertEqual(state, second_state)

    def test_manifest_and_state_tampering_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cartridge = root / "card"
            manifest, state = self.cartridge(cartridge)
            brain = FakeBrain(self.base)
            with self.verify_patches(), patch.object(v4.ref, "baseline", return_value=(self.base, brain)):
                (cartridge / "state.bin").write_bytes(state[:-1] + bytes([state[-1] ^ 1]))
                with self.assertRaisesRegex(ValueError, "commitment"):
                    v4.verify(cartridge)
                (cartridge / "state.bin").write_bytes(state)
                manifest["profile"]["strategy"]["buyPercent"] = 4
                (cartridge / "cartridge.json").write_bytes(v4.canonical_manifest(manifest))
                with self.assertRaisesRegex(ValueError, "Profile hash"):
                    v4.verify(cartridge)
                manifest["profile"]["strategy"]["buyPercent"] = 2
                raw = v4.canonical_manifest(manifest)
                (cartridge / "cartridge.json").write_bytes(raw[:-1] + b" \n")
                with self.assertRaisesRegex(ValueError, "not canonical"):
                    v4.verify(cartridge)

    def test_profile_schema_model_and_secret_boundaries_fail_closed(self):
        invalid = copy.deepcopy(self.spec)
        invalid["risk"]["privateKey"] = "secret"
        with self.assertRaisesRegex(ValueError, "Forbidden"):
            v4.validate_profile_spec(invalid)
        incompatible = copy.deepcopy(self.spec)
        incompatible["compatibility"]["brainModel"] = "unknown"
        with self.assertRaises(ValueError):
            v4.validate_profile_spec(incompatible)
        document = self.profile()
        document["metadata"]["profileHash"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            v4.validate_profile_document(document)

    def test_v3_wrap_adds_default_profile_and_truthful_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output = root / "v3", root / "v4"
            source.mkdir()
            state = v3.encode_arrays(self.values, self.base)
            v3_manifest = {"locks": self.locks, "fixedBootProbe": self.probe}
            (source / "cartridge.json").write_bytes(v4.canonical_manifest(v3_manifest))
            (source / "state.bin").write_bytes(state)
            source_id = "a" * 64
            with patch.object(v4.v3, "verify", return_value={"cardId": source_id}), \
                    patch.object(v4.ref, "baseline", return_value=(self.base, FakeBrain(self.base))):
                result = v4.wrap_v3(source, output, self.fly_id)
            wrapped = json.loads((output / "cartridge.json").read_bytes())
            self.assertEqual(wrapped["profile"], self.spec)
            self.assertEqual(wrapped["provenance"],
                             {"sourceFormatVersion": 3, "sourceCardId": "0x" + source_id})
            self.assertEqual((output / "state.bin").read_bytes(), state)
            self.assertEqual(result["sourceFormatVersion"], 3)

    def test_publishability_reports_limits_duplicate_parent_and_unapproved_carrier(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cartridge = root / "card"
            manifest, _ = self.cartridge(cartridge)
            brain = FakeBrain(self.base)
            with self.verify_patches(), patch.object(v4.ref, "baseline", return_value=(self.base, brain)):
                report = v4.publishability(cartridge)
                duplicate = v4.publishability(cartridge, {manifest["state"]["sha256"]})
            self.assertTrue(report["localValid"])
            self.assertTrue(report["candidateForV3Compatibility"])
            self.assertFalse(report["publishableToRegistryV3"])
            self.assertEqual(report["reasons"][0]["code"], "V3_CARRIER_NOT_APPROVED")
            self.assertFalse(duplicate["candidateForV3Compatibility"])
            self.assertIn("V3_DUPLICATE_STATE", [item["code"] for item in duplicate["reasons"]])


if __name__ == "__main__":
    unittest.main()
