#!/bin/bash
# Removes what sandbox-install.sh added on nusbf.
set -u
rm -rf /usr/local/ai-sandbox
loginctl disable-linger namlb
echo "sandbox runtime removed, lingering off"
