import unittest

from scripts.full_brain_profile_protocol import checkpoint_matches, checkpoint_metadata, validate_request


VALID = {
    "method": "observe",
    "id": 1,
    "flyId": "11111111-1111-4111-8111-111111111111",
    "profileRevision": 3,
    "profileHash": "sha256:" + "a" * 64,
    "modelVersion": "malecns-v1",
    "tokenAddress": "0x" + "1" * 40,
    "symbol": "TOKEN",
    "history": [1.0, 1.1],
    "price": 1.1,
    "pulse": "none",
    "pulseStrength": 0,
    "learning": False,
    "neuralMs": 500,
    "thresholdHz": 2,
    "checkpointEverySeconds": 60,
}


class FullBrainProfileProtocolTests(unittest.TestCase):
    def test_valid_observe_is_normalized(self):
        request = validate_request(dict(VALID))
        self.assertEqual(request["tokenAddress"], VALID["tokenAddress"])
        self.assertEqual(request["flyId"], VALID["flyId"])

    def test_unknown_and_missing_fields_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            validate_request({**VALID, "privateKey": "secret"})
        incomplete = dict(VALID)
        del incomplete["profileHash"]
        with self.assertRaisesRegex(ValueError, "missing fields"):
            validate_request(incomplete)

    def test_ranges_and_exact_types_are_enforced(self):
        for field, value in [
            ("learning", 1),
            ("checkpointEverySeconds", 29),
            ("neuralMs", float("nan")),
            ("history", [1, True]),
            ("flyId", "../escape"),
        ]:
            invalid = dict(VALID)
            invalid[field] = value
            with self.assertRaises(ValueError, msg=field):
                validate_request(invalid)

    def test_save_protocol_has_an_exact_shape(self):
        self.assertEqual(validate_request({"method": "save", "id": 2}), {"method": "save", "id": 2})
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            validate_request({"method": "save", "id": 2, "tokenAddress": VALID["tokenAddress"]})

    def test_checkpoint_metadata_contains_complete_provenance(self):
        metadata = checkpoint_metadata(VALID, "2026-09-19T00:00:00.000Z", "f" * 64)
        self.assertEqual(metadata["flyId"], VALID["flyId"])
        self.assertEqual(metadata["profileRevision"], 3)
        self.assertEqual(metadata["profileHash"], VALID["profileHash"])
        self.assertEqual(metadata["modelVersion"], "malecns-v1")
        self.assertEqual(metadata["tokenContext"]["address"], VALID["tokenAddress"])
        self.assertEqual(metadata["savedAt"], "2026-09-19T00:00:00.000Z")
        self.assertEqual(metadata["weightSha256"], "f" * 64)

    def test_checkpoint_identity_is_fly_and_model_not_token_alone(self):
        metadata = checkpoint_metadata(VALID, "2026-09-19T00:00:00.000Z", "f" * 64)
        other_token = {**VALID, "tokenAddress": "0x" + "2" * 40}
        self.assertTrue(checkpoint_matches(metadata, other_token))
        other_fly = {**VALID, "flyId": "22222222-2222-4222-8222-222222222222"}
        self.assertFalse(checkpoint_matches(metadata, other_fly))


if __name__ == "__main__":
    unittest.main()
