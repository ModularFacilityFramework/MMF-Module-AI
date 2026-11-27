#!/bin/bash
# Removes everything searxng-install.sh added on nusbf.
set -u
systemctl disable --now searxng.service
rm -f /etc/systemd/system/searxng.service
systemctl daemon-reload
rm -rf /etc/searxng /usr/local/searxng
userdel searxng
echo "SearXNG removed"
