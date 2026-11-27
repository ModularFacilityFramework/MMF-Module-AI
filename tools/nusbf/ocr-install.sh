#!/bin/bash
# OCR for the MFF AI module on nusbf: ocrmypdf (scanned PDFs) and Tesseract (images),
# from Debian. The packages this added are listed in /usr/local/ai-sandbox/ocr-packages.txt
# for the rollback (ocr-rollback.sh).
set -euo pipefail
NEW=$(apt-get install -s ocrmypdf tesseract-ocr tesseract-ocr-eng | awk '/^Inst/ {print $2}')
DEBIAN_FRONTEND=noninteractive apt-get install -y -q ocrmypdf tesseract-ocr tesseract-ocr-eng
mkdir -p /usr/local/ai-sandbox
echo $NEW > /usr/local/ai-sandbox/ocr-packages.txt
ocrmypdf --version; tesseract --version | head -1
