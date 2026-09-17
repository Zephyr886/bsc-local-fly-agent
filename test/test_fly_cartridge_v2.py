"""Pure safety checks for the candidate v2 manifest and state identity."""
import hashlib
import sys
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import fly_cartridge_v2 as v2  # noqa: E402
import fly_cartridge_state_ref as ref  # noqa: E402


class CandidateV2Tests(unittest.TestCase):
    def test_settings_accept_only_explicit_public_values(self):
        address = "0x" + "1" * 40
        valid = {"tokenAddress": address.upper().replace("0X", "0x"),
                 "fullLearning": True, "fullNeuralMs": 200, "fullThresholdHz": 3}
        self.assertEqual(v2.public_settings(valid),
                         {"tokenAddress": address, "fullLearning": True,
                          "fullNeuralMs": 200, "fullThresholdHz": 3})
        for extra in ({"privateKey": "secret"}, {"rpcKey": "secret"},
                      {"fullLearning": 1}, {"fullNeuralMs": float("nan")},
                      {"fullNeuralMs": 10}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                v2.public_settings({**valid, **extra})

    def test_state_key_includes_all_checkpoint_metadata(self):
        locks = {"runtimeSourceTreeSha256": "a" * 64}
        fields = {"weight": "b" * 64}
        settings = {"tokenAddress": "0x" + "1" * 40}
        first = v2.sha(v2.DOMAIN + ref.canonical(
            v2.identity({"cursor": 10, "eta": 0.001}, fields, locks, settings)))
        changed = v2.sha(v2.DOMAIN + ref.canonical(
            v2.identity({"cursor": 10, "eta": 0.002}, fields, locks, settings)))
        self.assertNotEqual(first, changed)
        self.assertEqual(first, hashlib.sha256(v2.DOMAIN + ref.canonical(
            v2.identity({"eta": 0.001, "cursor": 10}, fields, locks, settings))).hexdigest())

    def test_reject_invalid_state_envelope(self):
        with self.assertRaises(ValueError):
            v2.state_decode(b"not a state", {})
        with self.assertRaises(ValueError):
            v2.state_decode(v2.MAGIC + b"\xff\xff\xff\xff", {})


if __name__ == "__main__":
    unittest.main()
