#!/bin/bash
# Whisper (speech to text) for the MFF AI module on gpu6, GPU 3 next to Qwen.
# Assumes /home/ai/whisper/venv (faster-whisper 1.2.1, av 14.2.0, CUDA 12 cuBLAS/cuDNN)
# and /home/ai/models/whisper/large-v3-turbo (dropbox-dash/faster-whisper-large-v3-turbo, MIT).
# Listens on the private address only. Rollback: whisper-rollback.sh.
set -euo pipefail
W=/home/ai/whisper
L=$(ls -d $W/venv/lib/python3.12/site-packages/nvidia/*/lib | tr "\n" ":")
cat > /etc/systemd/system/ai-whisper.service <<UNIT
[Unit]
Description=Whisper speech to text for the MFF AI module (GPU 3, 192.168.1.16:8003)
After=network.target vllm-controller.service vllm-guard.service

[Service]
Type=simple
User=namlb
Group=DomainUsers
WorkingDirectory=$W
# after Qwen and the guard have taken their memory on GPU 3
ExecStartPre=/bin/sleep 150
ExecStart=$W/venv/bin/uvicorn whisper_server:app --host 192.168.1.16 --port 8003 --workers 1
Restart=on-failure
RestartSec=30
TimeoutStartSec=300
Environment=CUDA_VISIBLE_DEVICES=GPU-13e60c09-7068-97d4-09ae-3ca6a3cb859d
Environment=LD_LIBRARY_PATH=$L
Environment=HF_HUB_OFFLINE=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ai-whisper.service
