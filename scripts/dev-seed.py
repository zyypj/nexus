"""Seeds a local dev server with test users, friendships, a DM and groups.

Usage: python scripts/dev-seed.py [base_url]
Needs the server binary built (cargo build -p nexus-server) to create invites.
All users get the password "senha-teste-123".
"""

import json
import os
import subprocess
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
PASSWORD = "senha-teste-123"
USERS = [("joao", "João"), ("pedro", "Pedro"), ("lucas", "Lucas"), ("carlos", "Carlos"), ("marcos", "Marcos")]
TARGET = os.environ.get("CARGO_TARGET_DIR", os.path.join(os.path.dirname(__file__), "..", "target"))
BIN = os.path.join(TARGET, "debug", "nexus-server.exe" if os.name == "nt" else "nexus-server")


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json; charset=utf-8")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return {"_status": e.code, **json.loads(e.read() or b"{}")}


def invite():
    out = subprocess.run([BIN, "admin", "invite", "create", "--max-uses", "1"], capture_output=True, text=True, check=True)
    return out.stdout.splitlines()[1].strip()


def main():
    tokens, ids = {}, {}
    for username, name in USERS:
        res = call("POST", "/api/auth/login", body={"username": username, "password": PASSWORD})
        if "access_token" not in res:
            res = call(
                "POST",
                "/api/auth/register",
                body={"username": username, "display_name": name, "password": PASSWORD, "invite_code": invite()},
            )
        tokens[username] = res["access_token"]
        ids[username] = res["user"]["id"]
        print(f"user {username:8} {ids[username]}")

    def befriend(a, b):
        r = call("POST", "/api/friends/requests", tokens[a], {"username": b})
        if r.get("status") == "pending":
            call("POST", f"/api/friends/requests/{r['request']['id']}/accept", tokens[b], {})

    for a, b in [("joao", "pedro"), ("joao", "lucas"), ("pedro", "lucas"), ("carlos", "marcos"), ("joao", "carlos")]:
        befriend(a, b)

    dm = call("POST", "/api/conversations/dm", tokens["joao"], {"user_id": ids["pedro"]})
    convs = call("GET", "/api/conversations", tokens["joao"])
    if not any(c["kind"] == "group" for c in convs):
        call(
            "POST",
            "/api/conversations/group",
            tokens["joao"],
            {"name": "Grupo A", "member_ids": [ids["pedro"], ids["lucas"]]},
        )
        call("POST", "/api/conversations/group", tokens["carlos"], {"name": "Grupo B", "member_ids": [ids["marcos"]]})
        call(
            "POST",
            f"/api/conversations/{dm['id']}/messages",
            tokens["pedro"],
            {"content": "Oi João! Testando o **Nexus** com `código` e um link https://example.com"},
        )
    print("dm", dm["id"])
    with open(os.path.join(TARGET, "..", "dev-tokens.json"), "w", encoding="utf-8") as f:
        json.dump({"tokens": tokens, "ids": ids, "dm": dm["id"]}, f)


if __name__ == "__main__":
    main()
