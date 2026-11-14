import hashlib
import json
import math
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, urlopen

from usage import collect

CONFIG = json.loads(Path(__file__).with_name("audit-config.json").read_text(encoding="utf-8-sig"))
OLLAMA = "http://127.0.0.1:11434"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


LOCAL = build_opener(ProxyHandler({}), NoRedirect())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            tmp = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
        tmp.replace(path)
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def fingerprint(row):
    evidence = row["evidence"]
    value = [row["phase"], row["status"], evidence["text"], evidence["source"], evidence["failure"],
             [[t["name"], t["target"], t["result"], t["state"]] for t in evidence["tools"]]]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def cache_path(home, row):
    return home / "token-monitor" / "audit-v1" / row["project"] / (row["id"] + ".json")


def add_findings(home, rows):
    for row in rows:
        try:
            cached = json.loads(cache_path(home, row).read_text(encoding="utf-8"))
            if (cached.get("fingerprint") == fingerprint(row) and cached.get("category") in CONFIG["categories"]
                    and cached.get("outcome") in CONFIG["outcomes"] and all(isinstance(cached.get(k), str) for k in ("purpose", "result", "model"))):
                row["finding"] = cached
        except (OSError, ValueError, AttributeError, TypeError):
            pass


def local_json(path, data=None):
    request = Request(OLLAMA + path, data=json.dumps(data).encode() if data is not None else None,
                      headers={"Content-Type": "application/json"})
    with LOCAL.open(request, timeout=180 if data is not None else 5) as response:
        return json.load(response)


class LocalAudit:
    def __init__(self, home):
        self.home = home
        self.lock = Lock()

    def models(self):
        names = [m["name"] for m in local_json("/api/tags").get("models", [])
                 if m.get("name") and not m.get("remote_host") and "cloud" not in m["name"].lower()]
        return list(dict.fromkeys([m for m in CONFIG["preferredModels"] if m in names] + names))

    def batch(self, filters):
        if not self.lock.acquire(blocking=False):
            raise ValueError("本机审查正在运行")
        try:
            return self.run_batch(filters)
        finally:
            self.lock.release()

    def run_batch(self, filters):
        models = self.models()
        model = filters.get("model") or next(iter(models), None)
        if not model or model not in models:
            raise ValueError("Ollama 未安装所选本地模型")
        data = collect(self.home)
        add_findings(self.home, data["rows"])
        start, end, project = filters.get("start"), filters.get("end"), filters.get("project")
        rows = [r for r in data["rows"] if r["status"] != "running" and r.get("finding", {}).get("model") != model
                and (not project or r["project"] == project) and (start is None or r["at"] >= start)
                and (end is None or r["at"] < end)]
        selected = rows[:8]
        if not selected:
            return {"model": model, "processed": 0, "remaining": 0}
        subjects = {(t["project"], t["session"], t["id"]): t["request"] for t in data["turns"]}
        requests = []
        for i, row in enumerate(selected, 1):
            ev = row["evidence"]
            requests.append({"id": i, "phase": row["phase"], "subject": subjects.get(tuple(row["turn"])),
                             "observed": {"text": ev["text"], "failure": ev["failure"],
                                          "tools": [t | {"result": t["result"][:125]} for t in ev["tools"][:4]]}})
        body = {"model": model, "stream": False, "think": False, "format": "json",
                "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 2200},
                "messages": [{"role": "system", "content": CONFIG["system"]},
                             {"role": "user", "content": json.dumps({"categories": CONFIG["categories"],
                                "outcomes": CONFIG["outcomes"], "requests": requests}, ensure_ascii=False)}]}
        result = local_json("/api/chat", body)
        parsed = json.loads(result.get("message", {}).get("content") or "{}")
        items = parsed.get("items", [])
        by_id = {str(item.get("id")): item for item in items if isinstance(item, dict)} if isinstance(items, list) else {}
        processed = 0
        for i, row in enumerate(selected, 1):
            item = by_id.get(str(i), {})
            if item.get("category") not in CONFIG["categories"] or item.get("outcome") not in CONFIG["outcomes"]:
                continue
            write_json(cache_path(self.home, row), {
                "category": item["category"], "outcome": item["outcome"], "model": model,
                "purpose": str(item.get("purpose") or "")[:180], "result": str(item.get("result") or "")[:180],
                "fingerprint": fingerprint(row),
            })
            processed += 1
        if not processed:
            raise ValueError("本地模型没有返回有效分类，可重试或切换模型")
        return {"model": model, "processed": processed, "remaining": len(rows) - processed}


class Exchange:
    def __init__(self, home):
        self.file = home / "token-monitor" / "fx.json"
        self.current = CONFIG["fx"]
        self.lock = Lock()
        try:
            self.set(json.loads(self.file.read_text(encoding="utf-8")))
        except (OSError, ValueError, AttributeError, TypeError):
            pass

    def set(self, data):
        rate, date = data.get("rate"), data.get("date")
        if type(rate) in (int, float) and math.isfinite(rate) and rate > 0 and isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self.current = data
            return True
        return False

    def refresh(self):
        if not self.lock.acquire(blocking=False):
            return
        try:
            with urlopen(CONFIG["fxUrl"], timeout=6.5) as response:
                data = json.load(response)
            if self.set({"rate": data["rates"]["CNY"], "date": data["date"]}):
                write_json(self.file, self.current)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            self.lock.release()
