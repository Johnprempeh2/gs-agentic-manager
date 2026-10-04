"""Verify the GSAM memory gateway assertion (GRE-672, ADR-0001).

The GSAM server signs every engine call:
    base64url(json claims) + "." + base64url(hmac_sha256(secret, base64url(json claims)))
Claims: v, op, bank, read, write, doc, iat, exp, nonce. Lifetime is 60 seconds.
The signer is `server/src/services/memory-gateway/hindsight.ts`. This module has
no Hindsight imports so it can be tested on its own.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

HEADER = "x-gsam-memory-assertion"
MAX_LIFETIME_SECONDS = 60
CLOCK_SKEW_SECONDS = 5
OPS = {"retain", "recall", "delete", "configure"}


class AssertionError_(Exception):
    """The assertion is missing, malformed, badly signed or expired."""


@dataclass(frozen=True)
class Claims:
    op: str
    bank: str
    read: tuple[str, ...]
    write: tuple[str, ...]
    doc: str | None
    exp: int


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _string_list(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise AssertionError_(f"claim {name} must be a list of strings")
    return tuple(value)


def verify(header: str | None, secret: str, now: float | None = None) -> Claims:
    if not secret:
        raise AssertionError_("assertion secret is not configured")
    if not header or header.count(".") != 1:
        raise AssertionError_("missing or malformed assertion")
    payload, signature = header.split(".")
    expected = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, signature):
        raise AssertionError_("bad assertion signature")
    try:
        body = json.loads(_b64decode(payload))
    except (ValueError, UnicodeDecodeError) as exc:
        raise AssertionError_("unreadable assertion") from exc
    if not isinstance(body, dict) or body.get("v") != 1:
        raise AssertionError_("unsupported assertion version")
    now = time.time() if now is None else now
    iat, exp = body.get("iat"), body.get("exp")
    if not isinstance(iat, int) or not isinstance(exp, int):
        raise AssertionError_("assertion has no lifetime")
    if exp - iat > MAX_LIFETIME_SECONDS or iat > now + CLOCK_SKEW_SECONDS or exp < now:
        raise AssertionError_("assertion expired or not yet valid")
    op, bank, doc = body.get("op"), body.get("bank"), body.get("doc")
    if op not in OPS or not isinstance(bank, str) or not bank:
        raise AssertionError_("assertion names no operation or bank")
    if doc is not None and not isinstance(doc, str):
        raise AssertionError_("claim doc must be a string")
    return Claims(
        op=op,
        bank=bank,
        read=_string_list(body.get("read"), "read"),
        write=_string_list(body.get("write"), "write"),
        doc=doc,
        exp=exp,
    )
