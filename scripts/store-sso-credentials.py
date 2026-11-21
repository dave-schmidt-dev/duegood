#!/opt/homebrew/bin/python3 -I
"""Store the Marymount SSO credentials for automated Okta sign-in in OpenBao.

Run it yourself in a terminal. It prompts for the username, password, and Google
Authenticator setup key with hidden input, then writes all three as one KV v2
secret at kv/dm5mbp/DUEGOOD_MARYMOUNT_SSO with the existing `importer` AppRole
from the bws project. Values never appear in argv, the environment, shell history,
files, or output. It prints only OK/FAIL lines, and optionally the current
6-digit code so you can compare it with your phone.
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import json
import re
import struct
import sys
import time
from pathlib import Path

BWS_PROJECT = Path.home() / "Documents" / "Projects" / "bws"
SECRET_PATH = "dm5mbp/DUEGOOD_MARYMOUNT_SSO"
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._@+-]{1,128}$")


def normalize_seed(raw: str) -> str:
    """Matches the helper: drop spaces, hyphens, and padding; uppercase; base32 only."""
    seed = re.sub(r"[\s-]", "", raw).rstrip("=").upper()
    if not 16 <= len(seed) <= 128 or not re.fullmatch(r"[A-Z2-7]+", seed):
        raise ValueError("setup key must be 16-128 base32 characters (A-Z, 2-7)")
    return seed


def current_code(seed: str, now: float) -> str:
    """RFC 6238 TOTP (SHA-1, 30 s, 6 digits), identical to the helper."""
    key = base64.b32decode(seed + "=" * (-len(seed) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(now // 30)), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def prompt() -> dict[str, str]:
    username = getpass.getpass("Marymount Okta username (hidden): ").strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise ValueError("username must be 1-128 of letters, digits, . _ @ + -")
    password = getpass.getpass("Okta password (hidden): ")
    if not password or len(password) > 256 or any(ord(c) < 0x20 or ord(c) == 0x7F for c in password):
        raise ValueError("password is empty, too long, or has control characters")
    if getpass.getpass("Okta password again (hidden): ") != password:
        raise ValueError("passwords did not match")
    seed = normalize_seed(getpass.getpass("Google Authenticator setup key from 'Can't scan?' (hidden): "))
    return {"username": username, "password": password, "totp_seed": seed}


def store(values: dict[str, str]) -> None:
    sys.path.insert(0, str(BWS_PROJECT))
    from secret_backends import OpenBaoBackend, _openbao_request  # noqa: PLC0415

    bao = OpenBaoBackend("importer")
    role_id, secret_id = bao._approle_credentials()
    token = bao._login(role_id, secret_id)
    url = f"{bao._base_url()}/v1/kv/data/{SECRET_PATH}"
    try:
        # One write with all three keys: a KV v2 write replaces the whole secret.
        _openbao_request("POST", url, headers={
            "X-Vault-Token": token, "Content-Type": "application/json", "Accept": "application/json",
        }, body=json.dumps({"data": values}).encode("utf-8"))
        for key, value in values.items():
            if hashlib.sha256(bao._read_field(token, SECRET_PATH, key).encode()).digest() \
                    != hashlib.sha256(value.encode()).digest():
                raise RuntimeError(f"read-back mismatch for {key}")
            print(f"store {key}: OK")
    finally:
        bao._revoke(token)


def main() -> int:
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print("store-sso-credentials: run this in an interactive terminal.", file=sys.stderr)
        return 2
    try:
        values = prompt()
    except ValueError as error:
        print(f"store-sso-credentials: FAIL ({error})", file=sys.stderr)
        return 1
    if input("Show the current 6-digit code to compare with your phone? [y/N] ").strip().lower() == "y":
        print(f"Current code: {current_code(values['totp_seed'], time.time())}")
        if input("Does it match your phone? [y/N] ").strip().lower() != "y":
            print("store-sso-credentials: FAIL (setup key does not match; nothing stored)", file=sys.stderr)
            return 1
    if input(f"Write these to kv/{SECRET_PATH}? Type MUTATE to confirm: ").strip() != "MUTATE":
        print("store-sso-credentials: cancelled; nothing stored", file=sys.stderr)
        return 1
    try:
        store(values)
    except Exception as error:  # noqa: BLE001 - report the type only, never a value
        print(f"store-sso-credentials: FAIL ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    finally:
        values.clear()
    print(f"store-sso-credentials: OK (kv/{SECRET_PATH}: username, password, totp_seed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
