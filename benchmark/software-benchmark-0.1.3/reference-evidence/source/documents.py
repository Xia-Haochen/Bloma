import base64
import io
import json
import sys
from pypdf import PdfReader

item = json.loads(sys.stdin.buffer.read().decode("utf-8"))
raw = base64.b64decode(item["data"])
if item["name"].lower().endswith(".pdf"):
    pages = PdfReader(io.BytesIO(raw)).pages
    result = [{"location": f"page:{index + 1}", "text": line}
              for index, page in enumerate(pages)
              for line in (page.extract_text() or "").strip().splitlines() if line.strip()]
else:
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in raw:
        raise ValueError("不支持的编码，请使用 UTF-8")
    text = raw.decode("utf-8-sig", errors="strict")
    result = [{"location": f"line:{index + 1}", "text": line}
              for index, line in enumerate(text.splitlines())]
print(json.dumps(result, ensure_ascii=True))
