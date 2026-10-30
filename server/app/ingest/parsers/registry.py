from pathlib import Path

from app.ingest.parsers.pdf import parse_pdf


def parse_text_file(path: Path) -> tuple[list[tuple[dict, str]], dict]:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    return [({"offset": 0}, raw)], {"chars": len(raw)}


def parse_plain(text: str) -> tuple[list[tuple[dict, str]], dict]:
    return [({"offset": 0}, text)], {"chars": len(text)}


PARSERS = {
    ".pdf": parse_pdf,
    ".txt": parse_text_file,
    ".md": parse_text_file,
    ".csv": parse_text_file,
}


def parse(path: Path) -> tuple[list[tuple[dict, str]], dict]:
    fn = PARSERS.get(path.suffix.lower())
    if not fn:
        raise ValueError(f"P0 暂不支持该格式: {path.suffix}（等 P1）")
    return fn(path)
