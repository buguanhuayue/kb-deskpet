-- 0002_claim_job_setof.sql
-- 修：claim_job() 原返回复合类型 jobs，队列为空时 SELECT * FROM claim_job()
-- 仍然返回「一行全 NULL」，调用方 `if not job` 判不出来，会把 doc_id='None'
-- 当成真任务，随后 psycopg 报 invalid input syntax for type uuid: "None"，
-- worker 陷入 2 秒一次的自旋崩溃。
-- 改成 RETURNS SETOF jobs：没有可取任务时返回 0 行，语义正确。
-- 注意：PostgreSQL 不允许 CREATE OR REPLACE 直接改返回类型，必须先 DROP。
-- worker 也只通过 SELECT * FROM claim_job() 调用，DROP 是安全的（瞬时窗口除外）。

DROP FUNCTION IF EXISTS claim_job();

CREATE OR REPLACE FUNCTION claim_job() RETURNS SETOF jobs AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM jobs
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;
