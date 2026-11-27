#!/bin/bash
# Installs SearXNG on nusbf for the MFF AI module: 127.0.0.1:8888 only, as the
# system user searxng, source pinned to the commit in $SRC. Rollback: searxng-rollback.sh.
set -euo pipefail
SRC="$1"          # the cloned, pinned SearXNG source
BASE=/usr/local/searxng
id searxng >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin --comment "SearXNG for the MFF AI module" searxng
mkdir -p "$BASE" /etc/searxng
cp -a "$SRC" "$BASE/searxng-src"
chown -R searxng:searxng "$BASE"
sudo -H -u searxng python3 -m venv "$BASE/searx-pyenv"
sudo -H -u searxng bash -c "set -e; . $BASE/searx-pyenv/bin/activate; cd $BASE/searxng-src;
  pip install -q -U pip setuptools wheel pyyaml msgspec typing-extensions pybind11;
  pip install -q --use-pep517 --no-build-isolation -e .;
  pip install -q -r requirements-server.txt"
SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
cat > /etc/searxng/settings.yml <<YAML
# SearXNG for the MFF AI module (web_search tool). Read by: the MFF backends on this host only.
use_default_settings: true
general:
  instance_name: "MFF AI search"
  enable_metrics: false
server:
  secret_key: "$SECRET"
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  public_instance: false
  image_proxy: false
search:
  safe_search: 1
  formats: [html, json]
outgoing:
  request_timeout: 5.0
YAML
chown root:searxng /etc/searxng/settings.yml; chmod 640 /etc/searxng/settings.yml
cat > /etc/systemd/system/searxng.service <<UNIT
[Unit]
Description=SearXNG web search for the MFF AI module (127.0.0.1:8888 only)
After=network-online.target
Wants=network-online.target

[Service]
User=searxng
Group=searxng
WorkingDirectory=$BASE/searxng-src
Environment=SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
Environment=GRANIAN_INTERFACE=wsgi GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8888 GRANIAN_WORKERS=2 GRANIAN_BLOCKING_THREADS=4 GRANIAN_WEBSOCKETS=false
ExecStart=$BASE/searx-pyenv/bin/granian searx.webapp:app
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
systemctl daemon-reload
systemctl enable --now searxng.service
