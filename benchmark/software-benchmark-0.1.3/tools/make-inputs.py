"""Rebuild public inputs; release hashes freeze the generated outputs."""
import csv
import json
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1] / "inputs"
equipment = root / "equipment"
equipment.mkdir(parents=True, exist_ok=True)
tables = {
    "equipment.csv": [["id", "name", "total"], ["E01", "相机", 5], ["E02", "三脚架", 3], ["E03", "示波器", 2]],
    "members.csv": [["id", "name"], ["M01", "林舟"], ["M02", "陈雨"]],
    "equipment-invalid.csv": [["id", "name", "total"], ["E01", "重复相机", 2], ["E99", "错误数量", -1]],
    "equipment-extra.csv": [["id", "name", "total"], ["E04", "传感器", 4]],
}
for name, rows in tables.items():
    with (equipment / name).open("w", encoding="utf-8-sig", newline="") as file:
        csv.writer(file).writerows(rows)
(equipment / "FORMAT.md").write_text("器材列为id,name,total；成员列为id,name。UTF-8 CSV，id唯一，total为非负整数。日期基准2026-11-16。备份包含器材、成员、全部借还明细，可分多个CSV。\n", encoding="utf8")
docs = root / "documents"
sources = {
    "a/项目纪要.txt": ["青禾项目负责人是林舟。", "计划2026年11月20日交付。", "验收先检查记录重启，再检查导出。"],
    "b/项目纪要.txt": ["旧项目名为白石，负责人是陈雨。", "旧项目预算3000元，已于2025年结束。"],
    "预算.md": ["# 青禾预算", "本次预算300元。", "界面采用蓝色主题。"],
    "风险.md": ["# 风险记录", "故障时保留已完成结果。", "取消排队项后不得标记为已完成。"],
}
facts = {"files": {}, "search": [], "selected": ["a/项目纪要.txt", "预算.md", "交付.pdf"]}
for name, lines in sources.items():
    target = docs / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf8")
    facts["files"][name] = {"lines": lines}
    for index, line in enumerate(lines, 1):
        if "青禾" in line:
            facts["search"].append({"file": name, "location": f"line:{index}", "text": line})
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
for name, pages in {
    "交付.pdf": [["青禾交付清单", "交付物包括桌面程序、使用说明和数据备份。"], ["验收安排", "2026年11月20日检查保存和重启。"]],
    "会议.pdf": [["例会记录", "参与者林舟和陈雨。"], ["下一步", "每次提交保留来源索引。"]],
}.items():
    c = canvas.Canvas(str(docs / name), invariant=1)
    for page in pages:
        c.setFont("STSong-Light", 14)
        for index, line in enumerate(page):
            c.drawString(55, 780 - index * 35, line)
        c.showPage()
    c.save()
    extracted = [page.extract_text().strip() for page in PdfReader(str(docs / name)).pages]
    for expected, actual in zip(pages, extracted):
        assert all(line in actual for line in expected)
    facts["files"][name] = {"pages": pages}
    for index, page in enumerate(pages, 1):
        for line in page:
            if "青禾" in line:
                facts["search"].append({"file": name, "location": f"page:{index}", "text": line})
(docs / "损坏.pdf").write_bytes(b"%PDF-1.7\nintentionally truncated\n")
(docs / "不支持编码.txt").write_bytes("这是一份UTF16输入".encode("utf-16"))
(docs / "facts.json").write_text(json.dumps(facts, ensure_ascii=False, indent=2), encoding="utf8")
print(json.dumps({"valid_documents": len(facts["files"]), "search_hits": len(facts["search"]), "pdf_text_verified": True}))
