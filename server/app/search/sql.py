"""所有带权限谓词的检索 SQL 都集中在这个文件里。

铁律：权限过滤必须写在 SQL 的 WHERE 里，不允许"先查出来再在 Python 里过滤"。
否则一次 LIMIT 40 就可能把别人的 40 条全取回来，前端稍一改动就漏。
"""

# 可见性谓词：本人 / 本部门 / 显式 ACL / company 级公开
ACL = """
(
      d.visibility = 'company'
   OR d.owner_id = %(uid)s::uuid
   OR (d.visibility = 'dept' AND %(dept)s::uuid IS NOT NULL AND c.dept_id = %(dept)s::uuid)
   OR EXISTS (
        SELECT 1 FROM acl a
        WHERE a.doc_id = c.doc_id
          AND ((a.subject_type = 'user' AND a.subject_id = %(uid)s::uuid)
            OR (a.subject_type = 'dept' AND a.subject_id = %(dept)s::uuid))
      )
)
"""

_SELECT = """
SELECT c.id, c.doc_id, c.text, c.locator, c.dept_id,
       d.title, d.ext, d.source_type
"""

HYBRID = f"""
WITH vec AS (
    SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> %(emb)s::vector) AS rnk
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE d.status = 'ready'
      AND c.embedding IS NOT NULL
      AND {ACL}
    ORDER BY c.embedding <=> %(emb)s::vector
    LIMIT %(cand)s
),
kw AS (
    SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC) AS rnk
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    CROSS JOIN to_tsquery('simple', %(qtext)s) AS q(tsq)
    WHERE d.status = 'ready'
      AND c.tsv @@ q.tsq
      AND {ACL}
    ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC
    LIMIT %(cand)s
),
hit AS (
    SELECT id, 1.0 / (%(k)s + rnk) AS s FROM vec
    UNION ALL
    SELECT id, 1.0 / (%(k)s + rnk) AS s FROM kw
),
scored AS (
    SELECT id, SUM(s) AS rrf FROM hit GROUP BY id ORDER BY SUM(s) DESC LIMIT %(cand)s
)
{_SELECT}
     , s.rrf,
       1 - (c.embedding <=> %(emb)s::vector) AS cosine
FROM scored s
JOIN chunks c ON c.id = s.id
JOIN documents d ON d.id = c.doc_id
ORDER BY s.rrf DESC
"""

KEYWORD_ONLY = f"""
WITH kw AS (
    SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC) AS rnk
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    CROSS JOIN to_tsquery('simple', %(qtext)s) AS q(tsq)
    WHERE d.status = 'ready'
      AND c.tsv @@ q.tsq
      AND {ACL}
    ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC
    LIMIT %(cand)s
)
{_SELECT}
     , 1.0 / (%(k)s + kw.rnk) AS rrf,
       NULL::float AS cosine
FROM kw
JOIN chunks c ON c.id = kw.id
JOIN documents d ON d.id = c.doc_id
ORDER BY kw.rnk
"""
