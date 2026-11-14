import hashlib
import json
import math
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock, Thread
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, urlopen

from usage import collect

CONFIG = json.loads(Path(__file__).with_name("audit-config.json").read_text(encoding="utf-8-sig"))
OLLAMA = "http://127.0.0.1:11434"


RULES = [(category, *(re.compile(pattern, re.ASCII) if pattern else None for pattern in patterns))
         for category, patterns in CONFIG["rules"].items()]


def needs_audit(row):
    evidence = row["evidence"]
    groups = set()
    for tool in evidence["tools"]:
        category = next((category for category, name, target in RULES
                         if (name and name.search(tool["name"].lower()))
                         or (target and target.search(tool["target"].lower()))), None)
        if category:
            groups.add(category)
    classified = bool(groups) or row["phase"] in CONFIG["phaseCategories"]
    resolved = bool(evidence["failure"]) or any(tool["state"] in ("ok", "failed") for tool in evidence["tools"])
    return not classified or not resolved


def has_failure(row):
    evidence = row["evidence"]
    return bool(evidence["failure"] or any(t["state"] == "failed" for t in evidence["tools"]) or row.get("retries"))


def readable_summary(value):
    text = value.strip() if isinstance(value, str) else ""
    return "" if re.search(r'[�\r\n]|^[\[{`]|"(?:exit_code|stderr|stdout)"\s*:', text) else text[:180]


def needs_summary(row):
    return has_failure(row) and not readable_summary(row.get("finding", {}).get("failureSummary"))


def unreadable_failure_summary(row):
    for tool in row["evidence"]["tools"]:
        output = tool.get("diagnostic") or tool["result"]
        if tool["state"] == "failed" and "�" in output:
            if row["evidence"]["failure"]:
                return row["evidence"]["failure"] + "。"
            code = re.search(r'"exit_code"\s*:\s*(-?\d+)', output)
            action = "创建目录失败" if re.search(r"\bmkdir\b", tool["target"], re.I) else "命令执行失败" if code else "工具执行失败"
            return action + (f"（退出码 {code[1]}）" if code else "") + "。错误输出无法读取，具体原因无法确认。"
    return ""


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
        self.job = None

    def models(self):
        names = [m["name"] for m in local_json("/api/tags").get("models", [])
                 if m.get("name") and not m.get("remote_host") and "cloud" not in m["name"].lower()]
        return list(dict.fromkeys([m for m in CONFIG["preferredModels"] if m in names] + names))

    def status(self):
        with self.lock:
            return dict(self.job) if self.job else None

    def start(self, filters):
        if (not isinstance(filters, dict) or filters.get("mode", "pending") not in ("pending", "all")
                or any(key in filters and (type(filters[key]) not in (int, float) or not math.isfinite(filters[key]))
                       for key in ("start", "end"))):
            raise ValueError("无效的审查参数")
        with self.lock:
            if self.job and self.job["state"] in ("running", "stopping"):
                raise ValueError("本机审查正在运行")
            self.job = {"state": "running", "model": filters.get("model") or "", "processed": 0, "remaining": 0}
            initial = dict(self.job)
        Thread(target=self.run, args=(filters,), daemon=True).start()
        return initial

    def stop(self):
        with self.lock:
            if self.job and self.job["state"] == "running":
                self.job["state"] = "stopping"
            return dict(self.job) if self.job else None

    def run(self, filters):
        try:
            data = collect(self.home)
            add_findings(self.home, data["rows"])
            start, end, project = filters.get("start"), filters.get("end"), filters.get("project")
            def eligible(row):
                return needs_summary(row) or (not row.get("finding") and (filters.get("mode") == "all" or needs_audit(row)))

            pending = [r for r in data["rows"] if r["status"] != "running" and eligible(r)
                       and (not project or r["project"] == project) and (start is None or r["at"] >= start)
                       and (end is None or r["at"] < end)]
            with self.lock:
                self.job["remaining"] = len(pending)
                running = self.job["state"] == "running"
            if pending and running:
                models = self.models()
                model = filters.get("model") or next(iter(models), None)
                if not model or model not in models:
                    raise ValueError("Ollama 未安装所选本地模型")
                with self.lock:
                    self.job["model"] = model
                subjects = {(t["project"], t["session"], t["id"]): t["request"] for t in data["turns"]}
                while pending and self.status()["state"] == "running":
                    selected, pending = pending[:8], pending[8:]
                    add_findings(self.home, selected)
                    candidates = [row for row in selected if eligible(row)]
                    with self.lock:
                        self.job["remaining"] -= len(selected) - len(candidates)
                    if not candidates:
                        continue
                    deferred = self.classify(candidates, model, subjects)
                    with self.lock:
                        self.job["processed"] += len(candidates) - len(deferred)
                        self.job["remaining"] -= len(candidates) - len(deferred)
                    pending.extend(deferred)
            with self.lock:
                self.job["state"] = "stopped" if self.job["remaining"] else "completed"
        except Exception as error:
            with self.lock:
                self.job.update(state="error", error=str(error))

    def classify(self, selected, model, subjects):
        requests = []
        for i, row in enumerate(selected, 1):
            ev = row["evidence"]
            tools = sorted(ev["tools"], key=lambda tool: tool["state"] != "failed")[:4]
            requests.append({"id": i, "phase": row["phase"], "subject": subjects.get(tuple(row["turn"])),
                             "explainFailure": has_failure(row),
                             "observed": {"text": ev["text"], "failure": ev["failure"],
                                          "retries": row.get("retries", [])[:4],
                                          "tools": [{"name": t["name"], "target": t["target"], "state": t["state"],
                                                     "result": (t.get("diagnostic") or t["result"])[:480 if j == 0 else 120]}
                                                    for j, t in enumerate(tools)]}})
        body = {"model": model, "stream": False, "think": False, "format": "json",
                "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 2200},
                "messages": [{"role": "system", "content": CONFIG["system"]},
                             {"role": "user", "content": json.dumps({"categories": CONFIG["categories"],
                                "outcomes": CONFIG["outcomes"], "requests": requests}, ensure_ascii=False)}]}
        result = local_json("/api/chat", body)
        parsed = json.loads(result.get("message", {}).get("content") or "{}")
        items = parsed.get("items", [])
        by_id = {str(item.get("id")): item for item in items if isinstance(item, dict)} if isinstance(items, list) else {}
        deferred = []
        for i, row in enumerate(selected, 1):
            item = by_id.get(str(i), {})
            add_findings(self.home, [row])
            existing = row.get("finding")
            summary = readable_summary((existing or {}).get("failureSummary")) or unreadable_failure_summary(row) or readable_summary(item.get("failureSummary"))
            if needs_summary(row) and not summary:
                deferred.append(row)
                continue
            if not existing and (item.get("category") not in CONFIG["categories"] or item.get("outcome") not in CONFIG["outcomes"]):
                deferred.append(row)
                continue
            if not existing or needs_summary(row):
                finding = existing or {"category": item["category"], "outcome": item["outcome"], "model": model,
                    "purpose": str(item.get("purpose") or "")[:180], "result": str(item.get("result") or "")[:180],
                    "fingerprint": fingerprint(row)}
                if summary and has_failure(row):
                    finding = finding | {"failureSummary": summary, "summaryModel": model}
                write_json(cache_path(self.home, row), finding)
        if len(deferred) == len(selected):
            raise ValueError("本地模型没有返回有效分类，可重试或切换模型")
        return deferred


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
