-- Telecontinent HR Desk v2: additive migration. Does NOT drop or alter the existing hr_cases table or its data.
CREATE TABLE IF NOT EXISTS hrd_users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','lead','specialist','payroll','requestor','approver')),
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hrd_delegations (
  id TEXT PRIMARY KEY,
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  scope TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE TABLE IF NOT EXISTS hrd_matrix (
  matrix_key TEXT PRIMARY KEY,
  movement TEXT NOT NULL,
  initiating_record TEXT,
  recommender TEXT,
  reviewers TEXT,
  final_approver TEXT,
  employee_response TEXT,
  level INTEGER NOT NULL DEFAULT 2,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'Telecontinent Employee Movement Approval Process (initial matrix)',
  updated_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS hrd_movement_types (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  matrix_key TEXT NOT NULL,
  form_id INTEGER,
  letter_code TEXT,
  payroll_impact INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  acceptance INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS hrd_transactions (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  movement_code TEXT NOT NULL,
  status TEXT NOT NULL,
  emp_id TEXT,
  emp_name TEXT NOT NULL,
  project TEXT,
  new_project TEXT,
  dept TEXT,
  data TEXT NOT NULL,
  extracted TEXT,
  matrix_snapshot TEXT,
  legacy_case_id TEXT,
  originator TEXT NOT NULL,
  owner TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  effective_date TEXT,
  approved_at TEXT,
  hr_validated_by TEXT,
  hr_validated_at TEXT,
  outstanding TEXT,
  ver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_status ON hrd_transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_emp ON hrd_transactions(emp_id);
CREATE TABLE IF NOT EXISTS hrd_approvals (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  stage TEXT NOT NULL,
  role_label TEXT NOT NULL,
  conditional INTEGER NOT NULL DEFAULT 0,
  approver_name TEXT,
  approver_email TEXT,
  decision TEXT NOT NULL DEFAULT 'Pending',
  decided_at TEXT,
  remarks TEXT,
  evidence_doc_id TEXT,
  delegated_from TEXT,
  recorded_by TEXT,
  recorded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appr_txn ON hrd_approvals(txn_id);
CREATE TABLE IF NOT EXISTS hrd_documents (
  id TEXT PRIMARY KEY,
  txn_id TEXT,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  r2_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  retention_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_txn ON hrd_documents(txn_id);
CREATE TABLE IF NOT EXISTS hrd_letters (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  ref TEXT UNIQUE,
  template_code TEXT NOT NULL,
  status TEXT NOT NULL,
  preparer_email TEXT NOT NULL,
  preparer_role TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewer_email TEXT,
  reviewed_at TEXT,
  released_by TEXT,
  released_at TEXT,
  signatory_name TEXT NOT NULL,
  signatory_title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  supersedes_id TEXT,
  ack_type TEXT,
  ack_date TEXT,
  ack_doc_id TEXT,
  final_doc_id TEXT,
  final_docx_id TEXT,
  ver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_letter_txn ON hrd_letters(txn_id);
CREATE TABLE IF NOT EXISTS hrd_letter_versions (
  letter_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  vals TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (letter_id, version)
);
CREATE TABLE IF NOT EXISTS hrd_letter_events (
  id TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL,
  action TEXT NOT NULL,
  by_email TEXT NOT NULL,
  at TEXT NOT NULL,
  version INTEGER,
  comment TEXT
);
CREATE TABLE IF NOT EXISTS hrd_payroll (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL UNIQUE,
  letter_id TEXT,
  payroll_month TEXT NOT NULL,
  cutoff_treatment TEXT,
  prev_basic REAL,
  new_basic REAL,
  allowance_type TEXT,
  prev_allow REAL,
  new_allow REAL,
  retro INTEGER NOT NULL DEFAULT 0,
  final_pay INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  verifier TEXT,
  verified_at TEXT,
  processed_by TEXT,
  processed_at TEXT,
  remarks TEXT,
  ver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hrd_payroll_cycles (
  project TEXT PRIMARY KEY,
  cutoff_day INTEGER NOT NULL,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS hrd_keydates (
  id TEXT PRIMARY KEY,
  txn_id TEXT,
  kind TEXT NOT NULL,
  due_date TEXT NOT NULL,
  emp_name TEXT,
  note TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (txn_id, kind)
);
CREATE TABLE IF NOT EXISTS hrd_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  ref TEXT,
  old_value TEXT,
  new_value TEXT,
  remarks TEXT,
  doc_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON hrd_audit(entity_id);
CREATE TABLE IF NOT EXISTS hrd_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS hrd_counters (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
-- Used for the original HR Desk sync API only when the existing hr_cases table does not have compatible columns.
CREATE TABLE IF NOT EXISTS hrd_legacy (
  t TEXT NOT NULL,
  id TEXT NOT NULL,
  ver INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  by_email TEXT,
  updated_at TEXT,
  PRIMARY KEY (t, id)
);
