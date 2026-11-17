"""Package identical public offline speech resources for every benchmark system."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

source, target = map(Path, sys.argv[1:3])
if target.exists():
    raise ValueError("Use a fresh archive path")
target.parent.mkdir(parents=True, exist_ok=True)
files = [(source / name, "speech-models/sensevoice-int8/" + name)
         for name in ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"]]
for file in sorted((source / "tts-vits-zh").rglob("*")):
    if file.is_file():
        files.append((file, "speech-models/sensevoice-int8/" + file.relative_to(source).as_posix()))
for name in ["speech_runtime.py", "speech_locator.py"]:
    files.append((Path("main/templates/tools") / name, "speech-tools/" + name))
manifest = {"version": "0.1.3", "scope": "identical optional public assets for all production systems", "files": []}
with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
    for file, name in files:
        data = file.read_bytes()
        manifest["files"].append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        archive.writestr(name, data)
    archive.writestr("common-assets-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
Path("benchmarks/software-v0.1/common-assets-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
digest = hashlib.file_digest(target.open("rb"), "sha256").hexdigest()
target.with_suffix(".sha256.txt").write_text(digest + "  " + target.name + "\n", encoding="utf-8")
print(json.dumps({"archive": str(target), "files": len(files), "bytes": target.stat().st_size, "sha256": digest}))
