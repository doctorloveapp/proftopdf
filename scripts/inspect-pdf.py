"""Local PDF QA using Poppler's bounding-box export (no third-party Python deps)."""
import json
import pathlib
import subprocess
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parent.parent
target = root / "docs/pdf-qa/ProfToPdf-collaudo.pdf"
pdftotext = pathlib.Path.home() / "AppData/Local/Programs/MiKTeX/miktex/bin/x64/pdftotext.exe"
command = str(pdftotext) if pdftotext.exists() else "pdftotext"
xml_path = target.with_suffix(".xml")
subprocess.run([command, "-bbox-layout", str(target), str(xml_path)], check=True)
document = ET.parse(xml_path)
pages = document.findall(".//{http://www.w3.org/1999/xhtml}page")
words = []
violations = []
for number, page in enumerate(pages, 1):
    width, height = float(page.attrib["width"]), float(page.attrib["height"])
    for word in page.findall(".//{http://www.w3.org/1999/xhtml}word"):
        text = "".join(word.itertext())
        words.append(text)
        x1, x2 = float(word.attrib["xMin"]), float(word.attrib["xMax"])
        y1, y2 = float(word.attrib["yMin"]), float(word.attrib["yMax"])
        if x1 < 44 or x2 > width - 44 or y1 < 12 or y2 > height - 12:
            violations.append({"page": number, "bounds": [x1, y1, x2, y2]})
assert not violations, f"Content outside margins: {violations[:5]}"
assert len(pages) >= 8
assert sum("ProfToPdf" in word for word in words) == len(pages)
assert words.count("Punto") == 120, "Missing or duplicated list entries"
assert "Glossario" in words and "α," in words and "β," in words
report = {"pages": len(pages), "words": len(words), "marginViolations": len(violations),
          "allHeadersPresent": True, "listEntries": 120, "greekAndGlossaryPresent": True}
(target.parent / "inspection.json").write_text(json.dumps(report, indent=2), encoding="utf8")
print(json.dumps(report))
