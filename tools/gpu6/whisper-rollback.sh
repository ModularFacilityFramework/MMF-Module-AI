#!/bin/bash
# Removes the Whisper service from gpu6 (and, with --all, its venv and model).
set -u
systemctl disable --now ai-whisper.service
rm -f /etc/systemd/system/ai-whisper.service
systemctl daemon-reload
if [ "${1:-}" = "--all" ]; then rm -rf /home/ai/whisper /home/ai/models/whisper; fi
echo "Whisper removed"
