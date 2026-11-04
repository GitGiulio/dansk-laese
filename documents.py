import codecs
import re
import unicodedata
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.table import Table
from pypdf import PdfReader

from translation import words

MAX_FILE = 10 * 1024 * 1024
MAX_TEXT = 200_000


class ImportError(Exception):
    pass


def import_text(text: str) -> dict:
    if len(text) > MAX_TEXT:
        raise ImportError("Text is too long. Import at most 200,000 characters at a time.")
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = text.replace("\u00ad", "").strip("\ufeff \t\n")
    if not text.strip():
        raise ImportError("There is no readable text. Paste some Danish text or choose another file.")
    if "\x00" in text:
        raise ImportError("This does not look like a text document. Save it as UTF-8 TXT and try again.")
    parts = [part for part in re.split(r"\n[\t ]*\n+", text) if part.strip()]
    paragraphs = [{"id": i, "text": part, "words": words(part)}
                  for i, part in enumerate(parts)]
    return {"text": text, "paragraphs": paragraphs, "warnings": []}


def _docx_parts(container):
    for part in container.iter_inner_content():
        if isinstance(part, Table):
            for row in part.rows:
                # A merged cell can appear more than once in the row.
                seen = set()
                cells = []
                for cell in row.cells:
                    if cell._tc not in seen:
                        seen.add(cell._tc)
                        cells.append("\n".join(_docx_parts(cell)))
                yield "\t".join(cells)
        else:
            yield part.text


def extract_file(name: str, data: bytes) -> dict:
    if len(data) > MAX_FILE:
        raise ImportError("File is too large. Choose a file no bigger than 10 MiB.")
    suffix = Path(name).suffix.lower()
    warnings = []
    try:
        if suffix == ".txt":
            encoding = ("utf-16" if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
                        else "utf-8-sig")
            try:
                text = data.decode(encoding)
            except UnicodeDecodeError:
                text = data.decode("cp1252")
                warnings.append("TXT was decoded as Windows-1252. Check the Danish characters in the preview.")
        elif suffix == ".docx":
            with ZipFile(BytesIO(data)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 50 * 1024 * 1024:
                    raise ImportError("This DOCX expands beyond the safe extraction limit. Save a smaller document.")
            text = "\n\n".join(_docx_parts(Document(BytesIO(data))))
        elif suffix == ".pdf":
            reader = PdfReader(BytesIO(data))
            if reader.is_encrypted:
                raise ImportError("This PDF is encrypted. Save an unencrypted copy and import that instead.")
            parts, empty = [], []
            total = 0
            for number, page in enumerate(reader.pages, 1):
                extracted = page.extract_text() or ""
                total += len(extracted)
                if total > MAX_TEXT:
                    raise ImportError("Text is too long. Import at most 200,000 characters at a time.")
                if extracted.strip():
                    parts.append(extracted)
                else:
                    empty.append(number)
            if not parts:
                raise ImportError("No selectable text was found in this PDF. Scanned pages need OCR before import.")
            text = "\n\n".join(parts)
            if empty:
                pages = ", ".join(map(str, empty[:20])) + (" and more" if len(empty) > 20 else "")
                warnings.append(f"No text was extracted from PDF page(s) {pages}. They may be blank or need OCR; check the original.")
            warnings.append("PDF reading order and line breaks may differ from the original. Check and edit the preview.")
        elif suffix == ".doc":
            raise ImportError("Older .doc files are not supported. Save the document as DOCX or TXT first.")
        else:
            raise ImportError("Choose a TXT, DOCX, or searchable PDF file.")
    except ImportError:
        raise
    except Exception as exc:
        # Parser exception messages may contain document text or internal paths.
        raise ImportError("Could not read this file. It may be damaged or use an unsupported format. Try saving it as TXT.") from exc
    result = import_text(text)
    result["warnings"] = warnings
    return result
