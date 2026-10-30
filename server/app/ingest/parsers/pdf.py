"""PDF 解析：pypdfium2（Apache-2.0 / BSD），避开 PyMuPDF 的 AGPL。

输出统一结构：list[tuple[locator, text]]
"""
from pathlib import Path


def parse_pdf(path: Path) -> tuple[list[tuple[dict, str]], dict]:
    import pypdfium2 as pdfium

    pages: list[tuple[dict, str]] = []
    pdf = pdfium.PdfDocument(str(path))
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            text = page.get_textpage().get_text_range() or ""
            text = text.strip()
            if text:
                pages.append(({"page": i + 1}, text))
            page.close()
        meta = {"pages": len(pdf)}
    finally:
        pdf.close()
    return pages, meta
