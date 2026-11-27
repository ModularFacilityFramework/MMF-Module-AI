#!/bin/bash
# MCP servers for the MFF AI module on nusbf, localhost only, as system user aimcp.
# PDBe (official, EMBL-EBI) pdbe-mcp-server 2.0.1 on 127.0.0.1:8901 (/api, /search);
# BioMCP (genomoncology) biomcp-cli 0.9.3 on 127.0.0.1:8902 (/mcp). Rollback: mcp-rollback.sh.
set -euo pipefail
BASE=/usr/local/ai-mcp
id aimcp >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin --comment "MCP servers for the MFF AI module" aimcp
mkdir -p "$BASE"; chown aimcp:aimcp "$BASE"
for n in pdbe biomcp; do sudo -H -u aimcp python3 -m venv "$BASE/$n"; done
sudo -H -u aimcp "$BASE/pdbe/bin/pip" install -q -U pip
sudo -H -u aimcp "$BASE/pdbe/bin/pip" install -q 'pdbe-mcp-server==2.0.1'
sudo -H -u aimcp "$BASE/biomcp/bin/pip" install -q -U pip
sudo -H -u aimcp "$BASE/biomcp/bin/pip" install -q 'biomcp-cli==0.9.3'
unit() { # name description port execstart
cat > /etc/systemd/system/$1.service <<UNIT
[Unit]
Description=$2 (127.0.0.1:$3 only)
After=network-online.target
Wants=network-online.target

[Service]
User=aimcp
Group=aimcp
WorkingDirectory=$BASE
Environment=HOME=$BASE
ExecStart=$4
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$BASE
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}
unit ai-mcp-pdbe "PDBe MCP servers (EMBL-EBI) for the MFF AI module" 8901 "$BASE/pdbe/bin/pdbe-mcp-remote-server --host 127.0.0.1 --port 8901 --json-response --cors-origins none --workers 1"
unit ai-mcp-biomcp "BioMCP for the MFF AI module" 8902 "$BASE/biomcp/bin/biomcp serve-http --host 127.0.0.1 --port 8902"
systemctl daemon-reload
systemctl enable --now ai-mcp-pdbe.service ai-mcp-biomcp.service
