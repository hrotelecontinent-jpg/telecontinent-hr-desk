#!/usr/bin/env python3
"""Prepare a private, additive D1 import from an existing offline snapshot. Never connects to Cloudflare."""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3

KINDS = {'cases': 'case', 'keydates': 'kd', 'letters': 'letter'}
SCHEMA = '''CREATE TABLE IF NOT EXISTS hr_cases (
 t TEXT NOT NULL, id TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1,
 rev INTEGER NOT NULL DEFAULT 0, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
 by_email TEXT, updated_at TEXT, PRIMARY KEY(t,id));
CREATE TABLE IF NOT EXISTS hrd_import_validation (ok INTEGER CHECK(ok=1));'''

def quote(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"

def prepare(db):
    previous=db.row_factory
    try:
        db.row_factory=sqlite3.Row
        return _prepare(db)
    finally:
        db.row_factory=previous

def _prepare(db):
    columns = {r[1] for r in db.execute('PRAGMA table_info(hrdesk_objects)')}
    if not {'kind', 'record_id', 'data', 'version', 'updated_at'} <= columns:
        raise ValueError('Snapshot lacks the supported hrdesk_objects schema')
    rows = list(db.execute('SELECT kind,record_id,data,version,updated_at FROM hrdesk_objects ORDER BY kind,record_id'))
    counters = {}
    def counter(key, n):
        counters[key] = max(counters.get(key, 0), n)
    guards, inserts = [], []
    for rev, row in enumerate(rows, 1):
        if row['kind'] not in KINDS or not row['record_id'] or not isinstance(row['version'],int) or row['version'] < 1:
            raise ValueError('Invalid source record metadata; no output produced')
        data = json.loads(row['data'])
        if not isinstance(data, dict):
            raise ValueError('Source record must be a JSON object')
        t, rid, raw, ver = KINDS[row['kind']], row['record_id'], row['data'], row['version']
        # Fail on conflicting target data instead of replacing or silently ignoring it.
        guards.append(f"INSERT INTO hrd_import_validation(ok) SELECT 0 WHERE EXISTS (SELECT 1 FROM hr_cases WHERE t={quote(t)} AND id={quote(rid)} AND (data IS NOT {quote(raw)} OR ver!={ver} OR deleted!=0));")
        inserts.append(f"INSERT INTO hr_cases(t,id,ver,rev,data,deleted,updated_at) VALUES ({quote(t)},{quote(rid)},{ver},{rev},{quote(raw)},0,{quote(row['updated_at'])}) ON CONFLICT(t,id) DO NOTHING;")
        ref = str(data.get('ref', ''))
        case = re.fullmatch(r'HR-(\d{4})-(\d+)', ref)
        letter = re.fullmatch(r'(?:HR-LTR-(\d{4})-(\d+)|TC/HR/[^/]+/(\d{4})/(\d+)/[^/]+)', ref)
        if case:
            y, n = case.groups()
            for key in ['legacy_' + y, 'legacy_C' + y]: counter(key, int(n))
        if letter:
            y, n = letter.groups()[:2] if letter.group(1) else letter.groups()[2:]
            for key in ['legacy_L' + y, 'L' + y]: counter(key, int(n))
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='hrdesk_sequences'").fetchone():
        for kind, year, n in db.execute('SELECT kind,year,last_num FROM hrdesk_sequences'):
            if kind not in ['case', 'letter'] or not isinstance(year, int) or not isinstance(n, int) or n < 0:
                raise ValueError('Invalid source sequence')
            keys = ['legacy_L' + str(year), 'L' + str(year)] if kind == 'letter' else ['legacy_' + str(year), 'legacy_C' + str(year)]
            for key in keys: counter(key, n)
    sql = ['-- PRIVATE HR DATA: keep outside Git; apply only to a separately authorized staging D1.',
           '-- Apply core migration 0001 first. Old source tables are never altered.', SCHEMA, *guards, *inserts,
           f"INSERT INTO hrd_counters(k,n) VALUES ('legacy_rev',{len(rows)}) ON CONFLICT(k) DO UPDATE SET n=MAX(n,excluded.n);"]
    sql += [f"INSERT INTO hrd_counters(k,n) VALUES ({quote(k)},{n}) ON CONFLICT(k) DO UPDATE SET n=MAX(n,excluded.n);" for k, n in sorted(counters.items())]
    sql.append('DROP TABLE hrd_import_validation;')
    return '\n'.join(sql) + '\n', len(rows)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--sqlite', type=Path)
    source.add_argument('--sql-export', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # Neither source snapshots nor generated SQL belong in any checkout.
    import subprocess
    for path in [args.sqlite or args.sql_export, args.output]:
        parent = path.resolve().parent
        if subprocess.run(['git', '-C', str(parent), 'rev-parse', '--show-toplevel'], capture_output=True).returncode == 0:
            parser.error('Store source snapshots and generated migration SQL outside Git checkouts')
    if args.sqlite:
        db = sqlite3.connect(args.sqlite.resolve().as_uri() + '?mode=ro', uri=True)
    else:
        db = sqlite3.connect(':memory:')
        def authorize(action, arg1, arg2, *_):
            if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH): return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in ('load_extension','readfile','writefile'): return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        db.executescript(args.sql_export.read_text())
    try:
        sql, count = prepare(db)
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream: stream.write(sql)
    finally:
        db.close()
    print(f'Prepared additive import for {count} records; no remote connection or database mutation performed.')

if __name__ == '__main__': main()
