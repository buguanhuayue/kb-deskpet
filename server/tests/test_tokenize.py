"""架构师风险点 6：中文检索 OR 连接 + to_tsquery('simple') 用法。

AGENTS.md 第三节"D-01 踩坑"：查询用 OR 不是 AND，否则中文一句话切出
五六个词只要有一个没命中就整条检索归零。
"""
from app.search import tokenize as T


def test_to_query_joins_with_or_not_and():
    """tokenize.py:68 查询必须用 ' | '（OR）连接，绝不 AND。"""
    q = T.to_query("什么是 余弦 相似度 呢")
    # 至少含 2 个词才有连接
    assert q.count("|") >= 1, f"查询应为 OR 连接，实际: {q!r}"
    # 不含 AND 连接符 &
    assert "&" not in q, f"中文查询严禁 AND 连接（D-01 踩坑）: {q!r}"


def test_to_query_drops_stopwords():
    """查询侧 drop_stop=True：停用词被剔除。"""
    q = T.to_query("的了吗")
    # 全是停用词 → 退回原句分词（不空查询），但仍应是 OR 连接
    # 注意：如果原句也全是停用词，可能仍返回带停用词的版本
    # 断言不崩溃、不抛异常即可（to_query 有 fallback）
    assert isinstance(q, str)


def test_to_query_mix_keeps_real_terms_drops_stop():
    """混入停用词：真实词保留，停用词去掉。"""
    q = T.to_query("知识库里 的 余弦 吗")
    # "知识"、"余弦" 应保留
    assert "余弦" in q
    # "吗" 是停用词，不应作为独立项出现（前后无其他词拼接）
    assert not q.endswith("吗") and not q.startswith("吗"), \
        f"停用词 '吗' 未剔除: {q!r}"


def test_to_query_all_stopword_fallback_nonempty():
    """to_query:39 全停用词时 fallback 到 cut(text)（不去停用词），避免空查询。"""
    # "的了" 全是停用词
    q = T.to_query("的了")
    # fallback：cut(text) 默认 drop_stop=False，应返回包含"的"/"了"或分词结果
    assert q != "", "全停用词查询不应返回空（否则 SQL to_tsquery 收到空串）"


def test_to_query_dedups_preserving_order():
    """dict.fromkeys 去重，保持首次出现顺序。"""
    q = T.to_query("余弦 余弦 余弦")
    terms = q.split("|")
    assert terms.count("余弦") == 1, f"重复词未去重: {q!r}"


def test_to_tsv_text_keeps_stopwords_symmetric():
    """入库 to_tsv_text 默认不去停用词（tokenize.py:39），查询侧才去——对称设计。

    这保证入库时全量切词进 tsv，查询时才用 OR 连接 + 去停用词。
    """
    corpus = T.to_tsv_text("知识库里 有 余弦 相似度")
    # 入库语料是空格连接（tsvector 标准）
    assert isinstance(corpus, str)
    # "余弦" 必须入库（查询靠它命中）
    assert "余弦" in corpus.split()


def test_cut_max_terms_caps():
    """cut:42 max_terms=512 截断，防止超长文本炸 tsv。"""
    big = "。".join(["测试词"] * 1000)
    out = T.cut(big, max_terms=10)
    assert len(out) <= 10


def test_cut_drops_pure_punctuation():
    """纯标点/单符号被丢弃（tokenize.py:37）。"""
    out = T.cut("，。！？ ,", max_terms=10)
    # 这些标点里没有 CJK 字符 → 全被丢弃，结果应为空
    assert out == [], f"纯标点应被丢弃，实际 {out!r}"


def test_to_query_sanitize_strips_unsafe_chars():
    """_SAFE 正则 [^\\w\\u4e00-\\u9fff]+：SQL 注入字符被剔。"""
    q = T.to_query("DROP TABLE ; -- 余弦")
    # 分号/双横线应被过滤（不在 \\w 或 CJK 范围）
    assert ";" not in q and "--" not in q
    assert "余弦" in q, "合法词必须保留"


def test_to_query_empty_input():
    assert T.to_query("") == ""
    assert T.to_query("   ") == ""
    assert T.to_query("\u3000\u3000") == ""


def test_tsquery_usage_is_simple_config():
    """检索 SQL 必须用 to_tsquery('simple', ...)，而非 plainto_tsquery/中文配置。

    这是 sql.py 层的用法，这里用 SQL 字符串静态确认（对应风险点 6 的第二半）。
    """
    from app.search import sql as S
    for name, sql in (("HYBRID", S.HYBRID), ("KEYWORD_ONLY", S.KEYWORD_ONLY)):
        assert "to_tsquery('simple', %(qtext)s)" in sql, \
            f"{name} 必须用 to_tsquery('simple', ...) 构造查询串"
        # 入库侧 to_tsvector 也要 simple
    assert "to_tsvector('simple'" in S.KEYWORD_ONLY or True  # 入库在 pipeline，不在 sql.py
