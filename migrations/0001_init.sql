-- 0001_init.sql  ——  P0 文本闭环所需的最小 schema
-- 幂等：全部 IF NOT EXISTS，可重复执行

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  parent_id uuid REFERENCES departments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash text,
  api_token text UNIQUE,                -- P0 用 bearer token；接 SSO 后作废
  dept_id uuid REFERENCES departments(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','editor','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('text','file','video','image')),
  dept_id uuid NOT NULL REFERENCES departments(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsing','chunking','embedding','ready','failed')),
  storage_path text,
  mime text,
  bytes bigint,
  sha256 text,
  version int NOT NULL DEFAULT 1,
  visibility text NOT NULL DEFAULT 'dept' CHECK (visibility IN ('private','dept','company')),
  ext jsonb NOT NULL DEFAULT '{}'::jsonb,
  chunk_count int NOT NULL DEFAULT 0,
  error_code text,
  error_msg text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (dept_id, sha256)
);

CREATE TABLE IF NOT EXISTS acl (
  doc_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user','dept')),
  subject_id uuid NOT NULL,
  permission text NOT NULL DEFAULT 'read',
  PRIMARY KEY (doc_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dept_id uuid NOT NULL,
  seq int NOT NULL,
  text text NOT NULL,
  locator jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"page":12} / {"start":754,"end":812}
  token_count int,
  embedding vector(1024),
  embed_model text NOT NULL,
  tsv tsvector,
  UNIQUE (doc_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chunks_tsv  ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_dept ON chunks (dept_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'ingest',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed')),
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, run_after) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  user_id uuid,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 队列：一条 SQL 完成抢占，避免多 worker 抢同一任务
CREATE OR REPLACE FUNCTION claim_job() RETURNS jobs AS $$
DECLARE
  j jobs;
BEGIN
  UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM jobs
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO j;
  RETURN j;
END;
$$ LANGUAGE plpgsql;
