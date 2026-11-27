#!/bin/bash
# Removes the packages ocr-install.sh added on nusbf.
set -u
apt-get remove -y $(cat /usr/local/ai-sandbox/ocr-packages.txt)
rm -f /usr/local/ai-sandbox/ocr-packages.txt
