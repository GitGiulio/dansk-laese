from io import BytesIO

import pytest
from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from documents import ImportError as DocumentError, import_text, extract_file


def pdf_bytes(pages):
    writer = PdfWriter()
    for text in pages:
        page = writer.add_blank_page(width=600, height=800)
        if text is not None:
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding")})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
            stream = DecodedStreamObject()
            stream.set_data(b"BT /F1 12 Tf 40 750 Td (" + text.encode("cp1252") + b") Tj ET")
            page[NameObject("/Contents")] = writer._add_object(stream)
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def test_normalization_paragraphs_and_stable_words():
    result = import_text("A\u030ase så en ø.\r\n\r\n😀 Æbler og brød.")
    assert result["text"] == "Åse så en ø.\n\n😀 Æbler og brød."
    paragraphs = result["paragraphs"]
    assert len(paragraphs) == 2
    assert paragraphs[1]["words"][0] == {"id": 0, "text": "Æbler", "start": 2, "end": 7}
    assert import_text(result["text"])["paragraphs"] == paragraphs


def test_whitespace_only_paragraphs_do_not_leave_identifier_gaps():
    result = import_text("Hej.\n\n \n\nFarvel.")
    assert [p["id"] for p in result["paragraphs"]] == [0, 1]
    assert result["paragraphs"][1]["text"] == "Farvel."


@pytest.mark.parametrize("text", ["", " \n ", "x" * 200001])
def test_rejects_empty_or_oversized_text(text):
    with pytest.raises(DocumentError):
        import_text(text)


def test_txt_encodings():
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        result = extract_file("tekst.txt", "Æbler, øer og åer.".encode(encoding))
        assert result["text"] == "Æbler, øer og åer."


def test_docx_includes_body_tables_in_order():
    document = Document()
    document.add_paragraph("Før tabellen.")
    document.add_table(rows=1, cols=1).cell(0, 0).text = "I tabellen."
    document.add_paragraph("Efter tabellen.")
    out = BytesIO()
    document.save(out)
    result = extract_file("tekst.docx", out.getvalue())
    assert result["text"] == "Før tabellen.\n\nI tabellen.\n\nEfter tabellen."


def test_pdf_text_and_empty_page_warning():
    result = extract_file("tekst.pdf", pdf_bytes(["Danish: brød og mælk.", None]))
    assert "brød og mælk" in result["text"]
    assert any("2" in warning and "OCR" in warning for warning in result["warnings"])


def test_scan_requires_ocr():
    with pytest.raises(DocumentError, match="OCR"):
        extract_file("scan.pdf", pdf_bytes([None]))


def test_encrypted_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=600, height=800)
    writer.encrypt("secret")
    out = BytesIO()
    writer.write(out)
    with pytest.raises(DocumentError, match="encrypted"):
        extract_file("secret.pdf", out.getvalue())


@pytest.mark.parametrize("name,data,match", [("old.doc", b"x", "DOCX"), ("bad.pdf", b"bad", "read"), ("bad.docx", b"bad", "read"), ("image.png", b"x", "TXT"), ("large.txt", b"x" * (10 * 1024 * 1024 + 1), "10 MiB")])
def test_bad_files(name, data, match):
    with pytest.raises(DocumentError, match=match):
        extract_file(name, data)
