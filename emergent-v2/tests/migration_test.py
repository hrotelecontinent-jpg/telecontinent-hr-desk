import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', ROOT/'tools/prepare-legacy-migration.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class LegacyMigration(unittest.TestCase):
    def source(self):
        db=sqlite3.connect(':memory:')
        db.executescript('CREATE TABLE hrdesk_objects(kind TEXT,record_id TEXT,data TEXT,version INTEGER,updated_at TEXT); CREATE TABLE hrdesk_sequences(kind TEXT,year INTEGER,last_num INTEGER);')
        self.records=[('cases','c1',json.dumps({'id':'c1','emp':"TEST O’Name",'ref':'HR-2026-042','formId':1}),3,'2026-10-15'),('keydates','k1',json.dumps({'caseId':'c1','note':"TEST ' quoted"}),2,'2026-10-15'),('letters','l1',json.dumps({'caseId':'c1','ref':'TC/HR/PRO/2026/051/TEST'}),1,'2026-10-15')]
        db.executemany('INSERT INTO hrdesk_objects VALUES (?,?,?,?,?)',self.records)
        db.executemany('INSERT INTO hrdesk_sequences VALUES (?,?,?)',[('case',2026,44),('letter',2026,60)])
        return db
    def target(self):
        db=sqlite3.connect(':memory:');db.executescript((ROOT/'migrations/0001_hrdesk_v2_core.sql').read_text());return db
    def test_exact_records_versions_and_sequences_survive_and_rerun(self):
        source=self.source();before=list(source.execute('SELECT * FROM hrdesk_objects'))
        sql,count=migration.prepare(source);self.assertEqual(count,3)
        target=self.target();target.executescript(sql);target.executescript(sql)
        rows=target.execute('SELECT t,id,data,ver FROM hr_cases ORDER BY t').fetchall()
        expected=sorted([(migration.KINDS[k],rid,data,version) for k,rid,data,version,_ in self.records])
        self.assertEqual(rows,expected)
        counters=dict(target.execute('SELECT k,n FROM hrd_counters'))
        self.assertEqual(counters['legacy_L2026'],60);self.assertEqual(counters['L2026'],60)
        self.assertEqual(counters['legacy_2026'],44)
        self.assertEqual(list(source.execute('SELECT * FROM hrdesk_objects')),before)
    def test_conflicting_target_is_not_overwritten(self):
        sql,_=migration.prepare(self.source());target=self.target();target.executescript(sql)
        target.execute("UPDATE hr_cases SET data='{}' WHERE id='c1'");target.commit()
        with self.assertRaises(sqlite3.IntegrityError):target.executescript(sql)
        self.assertEqual(target.execute("SELECT data FROM hr_cases WHERE id='c1'").fetchone()[0],'{}')
    def test_invalid_json_and_schema_fail_before_output(self):
        db=self.source();db.execute("UPDATE hrdesk_objects SET data='invalid' WHERE record_id='c1'")
        with self.assertRaises(ValueError):migration.prepare(db)
        with self.assertRaises(ValueError):migration.prepare(sqlite3.connect(':memory:'))

if __name__=='__main__':unittest.main()
