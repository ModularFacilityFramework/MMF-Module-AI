#!/bin/bash
# Python runtime for the MFF AI module's read-only MSSQL tool on nusbf:
# pymssql 2.4.6 (LGPL-2.1, with FreeTDS built in), used by
# backend/lib/mssql_query.py. Root-owned; run by the backend's user. Rollback:
# dbtools-rollback.sh. (MariaDB needs nothing here: the module's own driver.)
set -euo pipefail
BASE=/usr/local/ai-dbtools
python3 -m venv "$BASE/venv"
"$BASE/venv/bin/pip" install -q -U pip
"$BASE/venv/bin/pip" install -q 'pymssql==2.4.6'
chown -R root:root "$BASE"; chmod -R go-w "$BASE"; chmod -R a+rX "$BASE"
"$BASE/venv/bin/python" -c "import pymssql; print('pymssql', pymssql.__version__)"
