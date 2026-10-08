"""Generates infrastructure/pterodactyl/egg-*.json (PTDL_v2).

Edit the definitions here, then run: python scripts/gen-eggs.py
"""

import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "infrastructure", "pterodactyl")
os.makedirs(OUT, exist_ok=True)


def var(name, env, default, desc, rules, editable=True, viewable=True):
    return {
        "name": name,
        "description": desc,
        "env_variable": env,
        "default_value": default,
        "user_viewable": viewable,
        "user_editable": editable,
        "rules": rules,
        "field_type": "text",
    }


nexus_install = """#!/bin/bash
# Downloads the launcher (nexus-start.sh) from the GitHub release. The launcher
# itself downloads/updates the nexus-server binary on every start.
set -e
cd /mnt/server
REPO="${GITHUB_REPO:-zyypj/nexus}"
VERSION="${NEXUS_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/nexus-start.sh"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION#v}/nexus-start.sh"
fi
echo "Downloading ${URL}"
curl -fsSL -o nexus-start.sh "$URL"
chmod +x nexus-start.sh
mkdir -p data/uploads
rm -f .nexus-version
echo "Installed. The server binary is downloaded on first start."
"""

nexus = {
    "_comment": "Nexus Server egg. Import in Admin > Nests > Import Egg. See docs/PTERODACTYL.md.",
    "meta": {"version": "PTDL_v2", "update_url": None},
    "exported_at": "2026-10-07T00:00:00+00:00",
    "name": "Nexus Server",
    "author": "admin@nexus.local",
    "description": "Nexus API + WebSocket gateway + SQLite + uploads (single Rust binary). Downloads and auto-updates itself from GitHub Releases. Data persists in /home/container/data.",
    "features": None,
    "docker_images": {"Debian (Pterodactyl yolk)": "ghcr.io/parkervcp/yolks:debian"},
    "file_denylist": [],
    "startup": "bash ./nexus-start.sh",
    "config": {
        "files": "{}",
        "startup": json.dumps({"done": "server listening"}),
        "logs": "{}",
        "stop": "^C",
    },
    "scripts": {
        "installation": {
            "script": nexus_install,
            "container": "ghcr.io/parkervcp/installers:debian",
            "entrypoint": "bash",
        }
    },
    "variables": [
        var(
            "GitHub repository",
            "GITHUB_REPO",
            "zyypj/nexus",
            "owner/repo whose GitHub Releases provide the server binary.",
            "required|string|max:100",
        ),
        var(
            "Version",
            "NEXUS_VERSION",
            "latest",
            "latest = always the newest release; or pin a version such as 0.2.0.",
            "required|string|max:32",
        ),
        var(
            "Auto update",
            "AUTO_UPDATE",
            "1",
            "1 = check GitHub on every start and install new releases (checksum verified). 0 = never.",
            "required|string|in:0,1",
        ),
        var("App name", "NEXUS_APP_NAME", "Nexus", "Name shown to clients.", "required|string|max:32"),
        var("Listen address", "NEXUS_HOST", "0.0.0.0", "Interface to bind inside the container. Keep 0.0.0.0.", "required|ip"),
        var(
            "Listen port",
            "NEXUS_PORT",
            "",
            "Leave empty to use the primary allocation port (recommended).",
            "nullable|integer|between:1,65535",
        ),
        var(
            "Public URL",
            "NEXUS_PUBLIC_URL",
            "",
            "Address clients use to reach this server, e.g. https://chat.example.com or http://203.0.113.5:3000.",
            "nullable|string|max:255",
        ),
        var(
            "Data directory",
            "NEXUS_DATA_DIR",
            "/home/container/data",
            "Persistent directory for nexus.db and uploads/ (inside the server volume).",
            "required|string|max:255",
            editable=False,
        ),
        var(
            "JWT secret",
            "JWT_SECRET",
            "",
            "Leave empty to auto-generate one on first start (stored in data/.jwt_secret). At least 32 characters if set.",
            "nullable|string|min:32|max:256",
            viewable=False,
        ),
        var(
            "LiveKit URL",
            "LIVEKIT_URL",
            "",
            "URL clients use for media, e.g. ws://203.0.113.5:7880 or wss://media.example.com. Empty disables calls.",
            "nullable|string|max:255",
        ),
        var(
            "LiveKit API URL",
            "LIVEKIT_API_URL",
            "",
            "Optional internal URL the server uses for LiveKit's API (defaults to LiveKit URL with ws->http).",
            "nullable|string|max:255",
        ),
        var("LiveKit API key", "LIVEKIT_API_KEY", "", "Must match the LiveKit egg.", "nullable|string|max:64"),
        var(
            "LiveKit API secret",
            "LIVEKIT_API_SECRET",
            "",
            "Must match the LiveKit egg. At least 32 characters.",
            "nullable|string|min:32|max:256",
            viewable=False,
        ),
        var(
            "Public registration",
            "ALLOW_PUBLIC_REGISTRATION",
            "false",
            "true lets anyone sign up without an invite code.",
            "required|string|in:true,false",
        ),
        var("Max upload size", "MAX_UPLOAD_SIZE", "25MB", "Per-file limit, e.g. 25MB, 100MB.", "required|string|max:16"),
        var("Log level", "LOG_LEVEL", "info", "error, warn, info, debug or trace.", "required|string|in:error,warn,info,debug,trace"),
        var(
            "Trust proxy",
            "TRUST_PROXY",
            "false",
            "true only behind a reverse proxy you control (uses X-Forwarded-For for rate limits).",
            "required|string|in:true,false",
        ),
        var(
            "TLS certificate",
            "NEXUS_TLS_CERT",
            "",
            "Optional PEM certificate path (e.g. /home/container/tls/fullchain.pem) to serve HTTPS directly.",
            "nullable|string|max:255",
        ),
        var("TLS key", "NEXUS_TLS_KEY", "", "Optional PEM private key path for HTTPS.", "nullable|string|max:255"),
    ],
}

lk_install = """#!/bin/bash
# Downloads the launcher; it installs/updates the official livekit-server
# binary (github.com/livekit/livekit) on every start.
set -e
cd /mnt/server
REPO="${GITHUB_REPO:-zyypj/nexus}"
curl -fsSL -o livekit-start.sh "https://github.com/${REPO}/releases/latest/download/livekit-start.sh"
chmod +x livekit-start.sh
rm -f .livekit-version
echo "Installed. LiveKit is downloaded on first start."
"""

livekit = {
    "_comment": "LiveKit SFU for Nexus. Needs 2 allocations: primary (TCP signaling + UDP media) and one for ICE/TCP. See docs/PTERODACTYL.md.",
    "meta": {"version": "PTDL_v2", "update_url": None},
    "exported_at": "2026-10-07T00:00:00+00:00",
    "name": "Nexus LiveKit",
    "author": "admin@nexus.local",
    "description": "Self-hosted LiveKit SFU (media only) using the official release binary, configured for Pterodactyl with a single UDP port.",
    "features": None,
    "docker_images": {"Debian (Pterodactyl yolk)": "ghcr.io/parkervcp/yolks:debian"},
    "file_denylist": [],
    "startup": "bash ./livekit-start.sh",
    "config": {
        "files": "{}",
        "startup": json.dumps({"done": "starting LiveKit server"}),
        "logs": "{}",
        "stop": "^C",
    },
    "scripts": {
        "installation": {"script": lk_install, "container": "ghcr.io/parkervcp/installers:debian", "entrypoint": "bash"}
    },
    "variables": [
        var(
            "LiveKit version",
            "LIVEKIT_VERSION",
            "1.13.9",
            "Official livekit-server release to run (tested: 1.13.9). Use latest to follow new releases.",
            "required|string|max:32",
        ),
        var(
            "Auto update",
            "AUTO_UPDATE",
            "1",
            "1 = install the configured version on start when it differs from the installed one.",
            "required|string|in:0,1",
        ),
        var(
            "GitHub repository (launcher)",
            "GITHUB_REPO",
            "zyypj/nexus",
            "Where the installer downloads livekit-start.sh from.",
            "required|string|max:100",
        ),
        var("API key", "LIVEKIT_API_KEY", "nexus", "Key name shared with the Nexus server.", "required|string|alpha_dash|max:64"),
        var(
            "API secret",
            "LIVEKIT_API_SECRET",
            "",
            "Random secret, at least 32 characters (e.g. openssl rand -hex 32). Same value in the Nexus egg.",
            "required|string|min:32|max:256",
            viewable=False,
        ),
        var(
            "Public IP",
            "LIVEKIT_PUBLIC_IP",
            "",
            "Public IPv4 of the node, announced to clients. Empty = discover via STUN.",
            "nullable|ip",
        ),
        var(
            "Domain",
            "LIVEKIT_DOMAIN",
            "",
            "Optional domain (needed only for TURN/TLS).",
            "nullable|string|max:255",
        ),
        var(
            "Signaling port",
            "LIVEKIT_PORT",
            "",
            "Empty = primary allocation (recommended). TCP for signaling.",
            "nullable|integer|between:1,65535",
        ),
        var(
            "UDP media port",
            "LIVEKIT_UDP_PORT",
            "",
            "Empty = same number as the primary allocation (its UDP side). All WebRTC UDP goes through this one port.",
            "nullable|integer|between:1,65535",
        ),
        var(
            "ICE/TCP port",
            "LIVEKIT_TCP_PORT",
            "7881",
            "Port of the SECOND allocation, used when a network blocks UDP.",
            "required|integer|between:1,65535",
        ),
        var(
            "Webhook URL",
            "LIVEKIT_WEBHOOK_URL",
            "",
            "Nexus webhook, e.g. http://203.0.113.5:3000/api/livekit/webhook (keeps call state correct when a client crashes).",
            "nullable|string|max:255",
        ),
        var("Max participants per room", "LIVEKIT_MAX_PARTICIPANTS", "25", "Per-call limit.", "required|integer|between:2,100"),
        var(
            "Enable TURN",
            "LIVEKIT_TURN_ENABLED",
            "false",
            "Embedded TURN for very restrictive networks. Needs an extra allocation (and a certificate for TLS).",
            "required|string|in:true,false",
        ),
        var("TURN UDP port", "LIVEKIT_TURN_UDP_PORT", "", "Third allocation for TURN/UDP (optional).", "nullable|integer|between:1,65535"),
        var("TURN TLS port", "LIVEKIT_TURN_TLS_PORT", "", "Allocation for TURN/TLS (optional, needs cert/key files).", "nullable|integer|between:1,65535"),
        var("Log level", "LOG_LEVEL", "info", "debug, info, warn or error.", "required|string|in:debug,info,warn,error"),
    ],
}

for name, data in [("egg-nexus-server.json", nexus), ("egg-nexus-livekit.json", livekit)]:
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
        f.write("\n")
print("ok")
