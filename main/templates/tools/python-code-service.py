"""Fixed, one-request Jedi adapter. Not LSP, a project interpreter, or a sandbox.
Only the host chooses this script/interpreter/site/snapshot. No project execution.
Dependencies are privately provisioned by the host; never auto-install packages.
"""
import time
started = time.perf_counter()
import sys
import os
import json
import hashlib
from pathlib import Path

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
request = json.loads(sys.stdin.read(2 * 1024 * 1024))
site = Path(request["site"]).resolve(strict=True)
workspace = Path.cwd().resolve()
snapshot = workspace / "source"
cache = workspace / "cache"
cache.mkdir(exist_ok=True)
# Windows/libuv may add USERPROFILE/PATH even to an explicit spawn env. Clear
# those defaults before importing any analysis dependency; never discover the
# user's home/cache/venv. -I/-S already prevent their Python import hooks.
system_root = os.environ.get("SystemRoot")
os.environ.clear()
os.environ.update({"HOME": str(workspace), "USERPROFILE": str(workspace), "TEMP": str(cache), "TMP": str(cache)})
if system_root:
    os.environ["SystemRoot"] = system_root
stdlib = Path(sys.base_prefix).resolve()
script = Path(__file__).resolve()
denied = set()
project_files = {str((snapshot / label).resolve()) for label in request.get("files", [])}


def within(root, path):
    return path == root or root in path.parents


def audit(event, args):
    if event.startswith(("subprocess.", "socket.", "os.exec", "os.spawn")) or event in ("os.system", "os.fork", "os.forkpty"):
        raise PermissionError("PYTHON_ANALYSIS_NO_EXECUTION_OR_NETWORK")
    if event == "exec":
        filename = getattr(args[0], "co_filename", "")
        if filename and not filename.startswith("<") and within(snapshot, Path(filename).resolve()):
            raise PermissionError("PYTHON_ANALYSIS_NO_PROJECT_EXECUTION")
    if event not in ("open", "os.listdir", "os.scandir", "os.mkdir", "os.remove", "os.rmdir", "os.rename"):
        return
    paths = [args[0]]
    if event == "os.rename":
        paths.append(args[1])
    for raw in paths:
        if isinstance(raw, int):
            if raw > 2:
                raise PermissionError("PYTHON_ANALYSIS_UNOWNED_FD")
            continue
        if raw is None:
            raw = os.getcwd()
        path = Path(os.fsdecode(raw)).resolve()
        writing = event in ("os.mkdir", "os.remove", "os.rmdir", "os.rename")
        if event == "open":
            mode, flags = args[1:3]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        allowed = within(cache, path) if writing else any(within(root, path) for root in (snapshot, cache, site, stdlib)) or path == script
        if not writing and event == "open" and within(snapshot, path) and str(path) not in project_files:
            allowed = False
        if not allowed:
            denied.add(str(path)[:240])
            raise PermissionError("PYTHON_ANALYSIS_READ_SCOPE_DENIED" if not writing else "PYTHON_ANALYSIS_WRITE_DENIED")


sys.addaudithook(audit)
# -I -S excludes cwd, PYTHONPATH, user/system site and .pth processing.
sys.path.insert(0, str(site))
import jedi
import parso
from jedi.api.environment import InterpreterEnvironment

if jedi.__version__ != "0.19.2" or parso.__version__ != "0.8.4":
    raise RuntimeError("PYTHON_BACKEND_VERSION_UNSUPPORTED")
jedi.settings.cache_directory = str(cache)
# Jedi 0.19.2 needs Parso's per-process tree cache for name filters. One
# disposable process owns one Script, so no cross-request/thread sharing.
jedi.settings.fast_parser = True
jedi.settings.allow_unsafe_interpreter_executions = False
jedi.settings.auto_import_modules = []


def main():
    if request.get("probe") is True:
        return {"ok": True, "backend": "jedi", "jediVersion": jedi.__version__, "parsoVersion": parso.__version__, "pythonVersion": sys.version.split()[0]}
    q = request["query"]
    file = (snapshot / q["path"]).resolve(strict=True)
    if not within(snapshot, file):
        raise ValueError("PYTHON_FILE_OUTSIDE_SNAPSHOT")
    # Static analysis only. Same-process environment avoids Jedi's default
    # unsandboxed environment subprocess. Never use jedi.Interpreter(project).
    project = jedi.Project(str(snapshot), sys_path=[str(snapshot)], smart_sys_path=False, load_unsafe_extensions=False)
    service = jedi.Script(path=str(file), project=project, environment=InterpreterEnvironment())
    items = []
    omitted = 0
    texts = {}

    def position(path, line, col):
        text = texts.setdefault(str(path), path.read_text(encoding="utf-8"))
        lines = text.splitlines()
        row = lines[line - 1] if 0 < line <= len(lines) else ""
        bom = 1 if line == 1 and row.startswith("\ufeff") else 0
        return {"line": line, "column": len(row[:col + bom].encode("utf-16-le")) // 2 + 1}

    def location(name):
        nonlocal omitted
        if name.module_path is None:
            omitted += 1
            return None
        path = Path(name.module_path).resolve()
        if not within(snapshot, path) or not path.is_file():
            omitted += 1
            return None
        text = path.read_bytes()
        return {"path": path.relative_to(snapshot).as_posix(), "version": "sha256:" + hashlib.sha256(text).hexdigest(),
                "start": position(path, name.line, name.column), "end": position(path, name.line, name.column + len(name.name))}

    kind = q["kind"]
    if kind in ("definition", "references"):
        lines = file.read_text(encoding="utf-8").splitlines()
        line = q["line"]
        if not 1 <= line <= len(lines):
            raise ValueError("INVALID_POSITION")
        prefix = lines[line - 1].encode("utf-16-le")[:(q["column"] - 1) * 2]
        if len(prefix) != (q["column"] - 1) * 2:
            raise ValueError("INVALID_POSITION")
        try:
            column = len(prefix.decode("utf-16-le")) - (1 if line == 1 and lines[0].startswith("\ufeff") else 0)
        except UnicodeDecodeError:
            raise ValueError("INVALID_POSITION")
        names = service.goto(line, column, follow_imports=True, follow_builtin_imports=False) if kind == "definition" else service.get_references(line, column, include_builtins=False, scope="project")
    elif kind == "symbol":
        names = service.get_names(all_scopes=True, definitions=True, references=False)
        if q.get("query"):
            names = [n for n in names if q["query"].casefold() in n.name.casefold()]
    elif kind == "diagnostics":
        names = []
        for error in service.get_syntax_errors():
            items.append({"kind": "diagnostic", "code": "SyntaxError", "category": "error", "message": error.get_message()[:1200], "messageTruncated": len(error.get_message()) > 1200,
                          "location": {"path": q["path"], "version": "sha256:" + hashlib.sha256(file.read_bytes()).hexdigest(), "start": position(file, error.line, error.column), "end": position(file, error.until_line, error.until_column)}})
    else:
        raise ValueError("INVALID_REQUEST")
    for name in names:
        if kind == "references" and q.get("includeDeclaration") is False and name.is_definition():
            continue
        loc = location(name)
        if loc is None:
            continue
        if kind == "definition":
            item = {"kind": kind, "name": name.name, "symbolKind": name.type, "location": loc}
        elif kind == "references":
            # Jedi identifies definitions, not general read/write dataflow.
            item = {"kind": "reference", "isDefinition": name.is_definition(), "writeAccess": "unknown", "location": loc}
        else:
            parent = name.parent()
            item = {"kind": kind, "name": name.name, "symbolKind": name.type, "container": parent.full_name or "" if parent else "", "location": loc}
        items.append(item)
    limit = q.get("limit", 80)
    return {"ok": True, "backend": "jedi", "jediVersion": jedi.__version__, "parsoVersion": parso.__version__, "pythonVersion": sys.version.split()[0],
            "items": items[:limit], "truncated": len(items) > limit, "boundary": {"deniedReads": len(denied), "omittedExternalResults": omitted, "examples": sorted(denied)[:8]}}


initialized = time.perf_counter()
try:
    result = main()
except Exception as error:
    code = str(error) if isinstance(error, ValueError) else "PYTHON_BACKEND_QUERY_FAILED"
    result = {"ok": False, "backend": "jedi", "error": {"code": code[:120], "message": "Static Python analysis failed; no cached or partial result was reused."}}
result["timings"] = {"backendImportMs": (initialized - started) * 1000, "queryMs": (time.perf_counter() - initialized) * 1000}
# stdout is one bounded JSON document, never arbitrary project prints.
while len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 48000 and result.get("items"):
    result["items"].pop()
    result["truncated"] = True
sys.stdout.write(json.dumps(result, ensure_ascii=False))
