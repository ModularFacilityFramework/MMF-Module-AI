#!/bin/bash
# Removes everything mcp-install.sh added on nusbf.
set -u
systemctl disable --now ai-mcp-pdbe.service ai-mcp-biomcp.service
rm -f /etc/systemd/system/ai-mcp-pdbe.service /etc/systemd/system/ai-mcp-biomcp.service
systemctl daemon-reload
rm -rf /usr/local/ai-mcp
userdel aimcp
echo "MCP servers removed"
