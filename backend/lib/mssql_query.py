"""One read-only query on the MSSQL server, for the MFF AI module's db_query_mssql
tool (backend/lib/dbTools.js). Reads a JSON request on stdin, writes JSON on
stdout. Run with /usr/local/ai-dbtools/venv/bin/python (pymssql 2.4.6)."""
import datetime, decimal, json, sys, uuid
import pymssql

req = json.load(sys.stdin)
MAX_CELL = 500

def cell(v):
    if v is None or isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return f"({len(v)} bytes)"
    if isinstance(v, uuid.UUID):
        return str(v)
    s = str(v)
    return s if len(s) <= MAX_CELL else s[:MAX_CELL] + "…"

out = {}
try:
    conn = pymssql.connect(server=req["host"], port=str(req.get("port") or 1433), user=req["user"], password=req["password"],
                           database=req.get("database") or "", login_timeout=5, timeout=int(req.get("timeout") or 10),
                           appname="mff-ai-readonly", autocommit=False)
    cur = conn.cursor()
    cur.execute("SET LOCK_TIMEOUT 5000")
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
    cur.execute(req["sql"])
    cols = [d[0] for d in (cur.description or [])]
    max_rows = int(req.get("max_rows") or 200)
    rows = cur.fetchmany(max_rows + 1) if cols else []
    out = {"columns": cols, "rows": [[cell(v) for v in r] for r in rows[:max_rows]], "cut": len(rows) > max_rows}
    conn.rollback()
    conn.close()
except Exception as e:
    a = e.args[0] if e.args else e
    if isinstance(a, tuple) and len(a) > 1:
        a = a[1]
    msg = a.decode("utf-8", "replace") if isinstance(a, bytes) else str(a)
    msg = msg.split("DB-Lib error message")[0].strip() or "the MSSQL server refused the query"
    out = {"error": msg.replace(str(req.get("password") or "\0"), "***")[:400]}
print(json.dumps(out, default=str))
