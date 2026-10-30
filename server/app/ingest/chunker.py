"""切片：切片的粒度决定检索上限，比换模型重要得多。

三条规则（P0 定死，改动要跑 eval 对比）：
1. 不跨页/跨时间戳合并 —— 保证引用页码永远准确；
2. 一个切片 300~500 字，超长段落按句子切，句内不切；
3. 同页相邻切片留 80 字重叠，避免答案被切断在边界。
"""
import re
from dataclasses import dataclass

MIN_CHARS = 300
MAX_CHARS = 500
OVERLAP = 80

_SENT = re.compile(r"(?<=[。！？；!?;])")


@dataclass
class Chunk:
    seq: int
    text: str
    locator: dict
    token_count: int


def _split_block(text: str) -> list[str]:
    """先按空行/换行切段，段太长再按句子切。"""
    out: list[str] = []
    for para in re.split(r"\n\s*\n|\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= MAX_CHARS:
            out.append(para)
            continue
        buf = ""
        for sent in _SENT.split(para):
            if not sent:
                continue
            if len(buf) + len(sent) > MAX_CHARS and buf:
                out.append(buf)
                buf = sent
            else:
                buf += sent
        if buf:
            out.append(buf)
    return out


def chunk_blocks(blocks: list[tuple[dict, str]], *, start_seq: int = 0) -> list[Chunk]:
    chunks: list[Chunk] = []
    seq = start_seq

    for locator, text in blocks:
        paras = _split_block(text)
        buf = ""
        for p in paras:
            if len(buf) + len(p) + 1 <= MAX_CHARS:
                buf = f"{buf}\n{p}" if buf else p
                if len(buf) >= MIN_CHARS:
                    chunks.append(Chunk(seq, buf, dict(locator), len(buf)))
                    seq += 1
                    tail = buf[-OVERLAP:] if len(buf) > OVERLAP else ""
                    buf = tail
                continue

            # buf + p 超长：先落 buf
            if buf.strip():
                chunks.append(Chunk(seq, buf, dict(locator), len(buf)))
                seq += 1
                tail = buf[-OVERLAP:] if len(buf) > OVERLAP else ""
                buf = f"{tail}\n{p}" if tail else p
            else:
                buf = p

        # 尾块保留（>4 字），几十字的短页/短章节也是有效知识，不能丢
        if buf.strip() and len(buf.strip()) > 4:
            # 尾块太短就并进上一块（同页才并）
            if (
                chunks
                and chunks[-1].locator == locator
                and len(chunks[-1].text) + len(buf) <= MAX_CHARS + 200
            ):
                chunks[-1].text = f"{chunks[-1].text}\n{buf}"
            else:
                chunks.append(Chunk(seq, buf, dict(locator), len(buf)))
                seq += 1

    return [c for c in chunks if c.text.strip()]


def embed_input(title: str, text: str) -> str:
    """进向量模型的文本：带上文档标题，补足切片丢掉的上下文。"""
    return f"{title}\n{text}"[:2000]
