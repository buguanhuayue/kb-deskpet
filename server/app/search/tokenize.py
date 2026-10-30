"""中文分词：入库与查询必须用同一套规则。

PostgreSQL 自带的中文分词对中文是废的（simple 配置只按空格/标点切），
所以策略是：Python 侧用 jieba 切成空格分隔，存进 tsv；查询时用同样的
方式切好再 to_tsquery('simple', ...)。
"""
import re

import jieba

jieba.setLogLevel(20)

_CJK = re.compile(r"[\u4e00-\u9fff]")
_NOISE = re.compile(r"[\s\u3000]+")
# jieba 不认的疑问/虚词，检索时剔除，避免把整句当词组去匹配
_STOP = set(
    "的 了 是 在 和 与 及 吗 呢 吧 啊 我 你 他 她 它 们 这 那 有 没有 怎么 如何 什么 哪些 "
    "请问 一下 可以 能 需要 关于 以及 还是 就是 这个 那个".split()
)


def normalize(text: str) -> str:
    text = text.replace("\u200b", "").replace("\xa0", " ")
    return _NOISE.sub(" ", text).strip()


def cut(text: str, *, drop_stop: bool = False, max_terms: int = 512) -> list[str]:
    text = normalize(text)
    if not text:
        return []
    terms: list[str] = []
    for tok in jieba.cut(text, HMM=True):
        tok = tok.strip()
        if not tok:
            continue
        # 纯标点/符号丢弃
        if not _CJK.search(tok) and len(tok) < 2:
            continue
        if drop_stop and tok in _STOP:
            continue
        terms.append(tok)
    return terms[:max_terms]


def to_tsv_text(text: str) -> str:
    """写入 chunks.tsv 的语料：分词后空格连接。"""
    return " ".join(cut(text))


_SAFE = re.compile(r"[^\w\u4e00-\u9fff]+")


def to_query(text: str) -> str:
    """构造 to_tsquery('simple', ...) 的入参：去停用词 + OR 连接。

    为什么是 OR 不是 AND：to_tsquery/plainto_tsquery 默认是"全部词都要命中"，
    中文一句话切出五六个词，只要有一个词不在文档里就整条检索归零——
    这是本项目踩过的坑。用 OR 让 ts_rank_cd 按命中数量排序，多命中的排前面。
    """
    terms = cut(text, drop_stop=True)
    if not terms:  # 全是停用词时退回原句分词，避免空查询
        terms = cut(text)
    safe = []
    for t in dict.fromkeys(terms):
        t = _SAFE.sub("", t).strip()
        if t:
            safe.append(t)
    return " | ".join(safe)
