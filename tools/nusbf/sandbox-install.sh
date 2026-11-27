#!/bin/bash
# Python runtime for the MFF AI module's code sandbox on nusbf (read-only for the
# sandbox; run through bubblewrap + a systemd user scope by backend/lib/sandbox.js).
# Also enables lingering for namlb, so its user manager (cgroup limits for each
# run) exists even when nobody is logged in. Rollback: sandbox-rollback.sh.
set -euo pipefail
BASE=/usr/local/ai-sandbox
python3 -m venv "$BASE/venv"
"$BASE/venv/bin/pip" install -q -U pip
"$BASE/venv/bin/pip" install -q numpy scipy pandas matplotlib biopython gemmi rdkit
"$BASE/venv/bin/pip" freeze > "$BASE/requirements.lock"
chown -R root:root "$BASE"; chmod -R go-w "$BASE"
# fonts cache for matplotlib, built once here (the sandbox cannot write it)
MPLCONFIGDIR="$BASE/mplconfig" "$BASE/venv/bin/python" -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1,2]); plt.savefig('/dev/null', format='png')"
chmod -R a+rX "$BASE"
loginctl enable-linger namlb
echo done
