"""Unit tests for the assertion verifier. Run: python3 -m unittest discover scripts/gs-memory/extension"""

import base64
import hashlib
import hmac
import json
import os
import unittest

from gsam_memory_assertion import AssertionError_, verify

SECRET = "test-secret-not-real"
NOW = 1_790_000_000


def sign(claims, secret=SECRET):
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{payload}.{sig}"


def claims(**overrides):
    base = {"v": 1, "op": "recall", "bank": "gs-c-main", "read": ["scope:org"], "write": [], "doc": None,
            "iat": NOW, "exp": NOW + 60, "nonce": "n"}
    base.update(overrides)
    return base


class VerifyTests(unittest.TestCase):
    def test_accepts_a_fresh_signed_assertion(self):
        got = verify(sign(claims()), SECRET, now=NOW + 1)
        self.assertEqual((got.op, got.bank, got.read), ("recall", "gs-c-main", ("scope:org",)))

    def test_rejects_missing_wrong_secret_tampered_and_expired(self):
        good = sign(claims())
        cases = {
            "missing": None,
            "garbage": "not-an-assertion",
            "wrong secret": sign(claims(), "other-secret"),
            "tampered": sign(claims(read=["scope:client:x"])).split(".")[0] + "." + good.split(".")[1],
            "expired": sign(claims(iat=NOW - 120, exp=NOW - 60)),
            "too long-lived": sign(claims(exp=NOW + 3600)),
            "future": sign(claims(iat=NOW + 600, exp=NOW + 660)),
            "unknown op": sign(claims(op="delete_bank")),
            "no bank": sign(claims(bank="")),
        }
        for name, header in cases.items():
            with self.subTest(name):
                with self.assertRaises(AssertionError_):
                    verify(header, SECRET, now=NOW + 1)

    def test_no_secret_configured_rejects_everything(self):
        with self.assertRaises(AssertionError_):
            verify(sign(claims(), ""), "", now=NOW + 1)

    @unittest.skipUnless(os.environ.get("GSAM_ASSERTION_FROM_TS"), "set by the server test that signs with TypeScript")
    def test_accepts_the_typescript_signer(self):
        got = verify(os.environ["GSAM_ASSERTION_FROM_TS"], os.environ["GSAM_ASSERTION_SECRET_FROM_TS"])
        self.assertEqual(got.op, "retain")


if __name__ == "__main__":
    unittest.main()
