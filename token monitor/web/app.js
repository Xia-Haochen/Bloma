const labels = {uncached: "非缓存输入", read: "缓存读取", write: "缓存写入", output: "输出"};
const keys = Object.keys(labels);
const statuses = {completed: "已完成", error: "异常", failed: "失败", running: "未记录结束", cancelled: "已取消", unknown: "未知"};
const pageSize = 15;
const number = new Intl.NumberFormat("zh-CN");
const clock = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
const datetime = new Intl.DateTimeFormat("zh-CN", {year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"});
const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 8});

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function table(headers, rows) {
  const result = element("table");
  const head = result.createTHead().insertRow();
  for (const title of headers) {
    const th = element("th", "", title);
    th.scope = "col";
    head.append(th);
  }
  const body = result.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
    }
  }
  return result;
}

export function mountTokenMonitor(root, transport) {
  const $ = id => root.querySelector("#" + id);
  let stopped = false;
  let timer;
  const state = {data: null, raw: "", query: {project: "", start: -Infinity, end: Infinity}, page: 0};
  const idFor = value => JSON.stringify(value);
  const inRange = item => (!state.query.project || item.project === state.query.project) &&
    item.at >= state.query.start && item.at < state.query.end;
  const emptyCounts = () => Object.fromEntries(keys.map(key => [key, 0]));
  const sum = (counts, selected = keys) => selected.reduce((total, key) => total + (counts[key] ?? 0), 0);
  const totalCounts = rows => rows.reduce((counts, row) => {
    keys.forEach(key => { counts[key] += row.counts[key] ?? 0; });
    return counts;
  }, emptyCounts());
  const count = n => n == null ? "—" : number.format(n);
  const modelLabel = row => row.provider + " / " + row.model;
  const dateLabel = at => datetime.format(at);

  function findPrice(row) {
    const catalog = state.data.pricing[row.provider];
    if (!catalog || /plan|coding/.test(row.channel)) return null;
    const name = row.model.toLowerCase();
    const undated = name.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
    const alias = row.provider === "DeepSeek" && /^deepseek-v4-flash(-vision-exp)?$/.test(name)
      ? "deepseek-flash" : undated;
    const rate = catalog.models[name] ?? catalog.models[alias];
    return rate ? {rate, catalog} : null;
  }

  function pricePair(row) {
    const found = findPrice(row);
    if (!found || row.missing) return null;
    const keysUsed = keys.filter(key => row.counts[key] > 0);
    const calc = rates => keysUsed.some(key => rates[key] == null) ? null :
      keysUsed.reduce((total, key) => total + rates[key] * row.counts[key], 0) / 1_000_000;
    const low = calc(found.rate);
    const high = calc(found.rate.peak ?? found.rate);
    return low == null || high == null ? null : [low, high];
  }

  function costLabel(min, max) {
    return min === max ? dollars.format(min) : dollars.format(min) + "–" + dollars.format(max);
  }

  function renderMetrics(rows) {
    const counts = totalCounts(rows);
    const priced = rows.map(pricePair).filter(Boolean);
    const amount = priced.reduce(([lo, hi], [min, max]) => [lo + min, hi + max], [0, 0]);
    $("total").textContent = count(sum(counts));
    $("input").textContent = count(sum(counts, ["uncached", "read", "write"]));
    $("input-sub").textContent = "缓存命中 " + count(counts.read) + " · 写入 " + count(counts.write);
    $("output").textContent = count(counts.output);
    $("calls").textContent = count(rows.length) + " 次模型请求";
    $("cost").textContent = priced.length ? costLabel(...amount) : "—";
    $("cost-sub").textContent = rows.length ? "可估价 " + priced.length + " / " + rows.length + " 次请求" : "美元 · 公开文本费率";
  }

  function localDay(at) {
    const dt = new Date(at);
    return [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()].map((part, i) => String(part).padStart(i ? 2 : 4, "0")).join("-");
  }

  function renderChart() {
    if (!state.data) return;
    const view = root.querySelector("[name=view]:checked").value;
    const selected = [...$("legend").querySelectorAll("input:checked")].map(input => input.value);
    const grouping = new Map();
    const rows = state.data.rows.filter(inRange);
    if (view === "phase") Object.values(state.data.phases).forEach(label => grouping.set(label, emptyCounts()));
    for (const row of rows) {
      const group = view === "phase" ? state.data.phases[row.phase] : view === "model" ? modelLabel(row) : localDay(row.at);
      const counts = grouping.get(group) ?? emptyCounts();
      keys.forEach(key => { counts[key] += row.counts[key] ?? 0; });
      grouping.set(group, counts);
    }
    const groups = [...grouping];
    if (view === "time") groups.sort(([left], [right]) => left.localeCompare(right));
    if (view === "model") groups.sort(([, left], [, right]) => sum(right, selected) - sum(left, selected));
    const max = groups.reduce((top, [, counts]) => Math.max(top, sum(counts, selected)), 1);
    $("chart-caption").textContent = {
      time: "按请求开始日期汇总 · " + groups.length + " 个有记录的日期",
      phase: "按工作流步骤汇总 · 历史记录可按角色推断",
      model: "按供应商与模型汇总 · " + groups.length + " 个模型组合",
    }[view];
    const bars = groups.map(([name, counts]) => {
      const row = element("div", "chart-row");
      const values = selected.map(key => labels[key] + " " + count(counts[key])).join("，");
      const track = element("div", "track");
      track.setAttribute("role", "img");
      track.setAttribute("aria-label", name + "，" + values);
      track.title = values;
      for (const key of selected) {
        const section = element("span", key);
        section.style.width = (counts[key] * 100 / max) + "%";
        track.append(section);
      }
      row.append(element("span", "chart-name", name), track, element("strong", "chart-total", count(sum(counts, selected))));
      return row;
    });
    const message = selected.length ? "所选项目和时间内暂无请求。" : "勾选至少一种 Token 类别以显示图表。";
    $("chart").replaceChildren(...(selected.length && bars.length ? bars : [element("p", "empty", message)]));
  }

  function turnView(turn, rows, openIds) {
    const details = element("details", "turn");
    details.dataset.turn = idFor([turn.project, turn.session, turn.id]);
    details.open = openIds.has(details.dataset.turn);
    const summary = element("summary");
    const subject = element("span");
    subject.append(element("span", "turn-title", turn.request));
    const meta = [dateLabel(turn.at), state.data.projects[turn.project]];
    if (rows.some(row => row.inferred)) meta.push("轮次关联为推断");
    if (turn.unlinked) meta.push("独立请求");
    subject.append(element("span", "turn-meta", meta.join(" · ")));
    const grouping = element("span");
    for (const phase of new Set(rows.map(row => row.phase))) {
      grouping.append(element("span", "stage", state.data.phases[phase]));
    }
    const models = [...new Set(rows.map(modelLabel))];
    grouping.append(element("span", "turn-model", models.join("、") || "暂无请求记录"));
    summary.append(subject, grouping, element("strong", "number", rows.some(row => !row.missing || sum(row.counts)) ? count(sum(totalCounts(rows))) : "—"));
    const body = element("div", "turn-detail");
    body.append(element("p", "", "用户摘要 · " + turn.request));
    body.append(element("p", "", "回复摘要 · " + (turn.reply || "暂无可提取的回复")));
    if (rows.length) {
      const counts = totalCounts(rows);
      if (rows.some(row => row.phase_inferred)) body.append(element("p", "", "部分历史请求的阶段按运行角色推断。"));
      body.append(element("p", "", keys.map(key => labels[key] + " " + count(counts[key])).join(" · ")));
      const wrapper = element("div", "wide-table");
      wrapper.append(table(["请求开始", "阶段", "供应商 / 模型", ...Object.values(labels), "估算 USD", "状态"],
        rows.slice().sort((a, b) => a.at - b.at).map(row => {
          const cost = pricePair(row);
          const status = (statuses[row.status] ?? row.status) + (row.missing ? " · 缺用量" : "") +
            (row.failed ? " · " + row.failed + " 次未成功传输" : "");
          const model = element("span", "", modelLabel(row));
          model.title = [row.host, row.channel].filter(Boolean).join(" · ");
          return [dateLabel(row.at), state.data.phases[row.phase] + (row.phase_inferred ? "（推断）" : ""), model,
            ...keys.map(key => count(row.counts[key])), cost ? costLabel(...cost) : "—", status];
        })));
      body.append(wrapper);
    } else {
      body.append(element("p", "", "当前筛选范围内没有关联的请求用量。"));
    }
    details.append(summary, body);
    return details;
  }

  function renderTurns(rows) {
    const byTurn = new Map();
    for (const row of rows) {
      const id = idFor(row.turn);
      if (!byTurn.has(id)) byTurn.set(id, []);
      byTurn.get(id).push(row);
    }
    const query = $("search").value.trim().toLowerCase();
    const turns = state.data.turns.filter(turn => {
      const calls = byTurn.get(idFor([turn.project, turn.session, turn.id])) ?? [];
      return (calls.length || inRange(turn)) &&
        [turn.request, turn.reply, state.data.projects[turn.project], ...calls.map(modelLabel)].some(value => value.toLowerCase().includes(query));
    }).sort((a, b) => b.at - a.at);
    const pages = Math.ceil(turns.length / pageSize);
    state.page = Math.min(state.page, Math.max(0, pages - 1));
    $("turn-count").textContent = count(turns.length) + " 条对话或独立请求";
    $("pagination").hidden = pages <= 1;
    $("page-label").textContent = (state.page + 1) + " / " + pages;
    $("previous").disabled = !state.page;
    $("next").disabled = state.page >= pages - 1;
    const openIds = new Set([...$("turns").querySelectorAll("details[open]")].map(item => item.dataset.turn));
    const children = turns.slice(state.page * pageSize, (state.page + 1) * pageSize).map(turn =>
      turnView(turn, byTurn.get(idFor([turn.project, turn.session, turn.id])) ?? [], openIds));
    $("turns").replaceChildren(...(children.length ? children : [element("p", "empty", "没有符合条件的对话。")]));
  }

  function renderPrices(rows) {
    const catalog = state.data.pricing;
    $("price-sources").replaceChildren(...Object.entries(catalog).map(([provider, entry]) => {
      const link = element("button", "source-button", provider + " · " + (entry.state === "live" ? "官网已同步" : "缓存"));
      link.type = "button";
      link.addEventListener("click", async () => {
        try { await transport.openSource(provider, entry.url); }
        catch { $("price-update").textContent = "无法打开官方价格页"; }
      });
      link.title = entry.error ? "上次刷新失败：" + entry.error : "打开官方价格页";
      return link;
    }));
    const models = new Map(rows.map(row => [idFor([row.provider, row.model, row.channel]), row]));
    if ($("all-models").checked) {
      models.clear();
      for (const [provider, entry] of Object.entries(catalog)) {
        for (const model of Object.keys(entry.models)) models.set(idFor([provider, model]), {provider, model, channel: ""});
      }
    }
    const rates = [...models.values()].sort((a, b) => modelLabel(a).localeCompare(modelLabel(b))).map(row => {
      const found = findPrice(row);
      if (!found) return [modelLabel(row), ...keys.map(() => "—"), "无可用公开费率"];
      const {rate, catalog: entry} = found;
      const updated = rate.as_of ?? entry.as_of;
      const live = entry.state === "live" && rate.as_of === entry.checked;
      return [modelLabel(row), ...keys.map(key => {
        const low = rate[key];
        const high = rate.peak?.[key];
        return low == null ? "—" : high != null && high !== low ? low + "–" + high : String(low);
      }), (live ? "官网" : "缓存") + " · " + updated.slice(0, 10)];
    });
    $("price-table").replaceChildren(models.size ?
      table(["供应商 / 模型", ...Object.values(labels), "来源 / 日期"], rates) :
      element("p", "empty", "当前筛选无模型调用，可勾选查看全部已知模型。"));
  }

  function render() {
    if (!state.data) return;
    const rows = state.data.rows.filter(inRange);
    const notices = [];
    const incomplete = rows.filter(row => row.missing || row.failed).length;
    if (incomplete) notices.push(incomplete + " 次请求有缺失用量或未成功传输，合计只包含已上报用量。");
    const {malformed, unreadable} = state.data.issues;
    if (malformed) notices.push("已跳过 " + malformed + " 条无效日志。");
    if (unreadable) notices.push(unreadable + " 个日志文件暂不可读。");
    $("notice").hidden = !notices.length;
    $("notice").textContent = notices.join(" ");
    renderMetrics(rows);
    renderChart();
    renderTurns(rows);
    if ($("prices").open) renderPrices(rows);
  }

  function setProjects() {
    const project = $("project");
    const pending = project.value;
    const options = Object.entries(state.data.projects).sort(([, left], [, right]) => left.localeCompare(right, "zh"));
    project.replaceChildren(new Option("全部项目", ""), ...options.map(([id, name]) => new Option(name, id)));
    project.value = options.some(([id]) => id === pending) ? pending : "";
  }

  async function load() {
    try {
      const data = await transport.read();
      if (stopped) return;
      const raw = JSON.stringify(data);
      if (raw !== state.raw) {
        state.data = data;
        setProjects();
        render();
        state.raw = raw;
      }
      $("live").dataset.state = "ready";
      $("live").textContent = "已同步 " + clock.format(Date.now());
    } catch {
      if (stopped) return;
      $("live").dataset.state = "error";
      $("live").textContent = "连接中断，等待重连";
    } finally {
      if (!stopped) timer = setTimeout(load, 5000);
    }
  }

  $("filters").addEventListener("submit", event => {
    event.preventDefault();
    const start = $("start").value ? new Date($("start").value).getTime() : -Infinity;
    const end = $("end").value ? new Date($("end").value).getTime() + 60_000 : Infinity;
    if (start >= end) {
      $("end").setCustomValidity("结束时间须晚于或等于开始时间");
      $("end").reportValidity();
      return;
    }
    state.query = {project: $("project").value, start, end};
    state.page = 0;
    render();
  });
  for (const field of ["start", "end"]) $(field).addEventListener("input", () => $("end").setCustomValidity(""));
  $("clear-filters").addEventListener("click", () => {
    $("filters").reset();
    $("end").setCustomValidity("");
    $("filters").requestSubmit();
  });
  $("legend").addEventListener("change", renderChart);
  root.querySelector(".switcher").addEventListener("change", renderChart);
  $("search").addEventListener("input", () => {
    state.page = 0;
    if (state.data) renderTurns(state.data.rows.filter(inRange));
  });
  for (const [id, step] of [["previous", -1], ["next", 1]]) {
    $(id).addEventListener("click", () => {
      state.page += step;
      renderTurns(state.data.rows.filter(inRange));
    });
  }
  function refreshPriceView() {
    if (state.data) renderPrices(state.data.rows.filter(inRange));
  }
  $("prices-open").addEventListener("click", () => {
    $("prices").showModal();
    refreshPriceView();
  });
  $("prices-close").addEventListener("click", () => $("prices").close());
  $("all-models").addEventListener("change", refreshPriceView);
  $("refresh-prices").addEventListener("click", async () => {
    const button = $("refresh-prices");
    button.disabled = true;
    $("price-update").textContent = "正在核对官网价格…";
    try {
      const pricing = await transport.refreshPrices();
      if (stopped) return;
      if (state.data) state.data.pricing = pricing;
      const live = Object.values(pricing).filter(entry => entry.state === "live").length;
      $("price-update").textContent = live + " 家官网已同步，其余显示缓存";
      render();
    } catch {
      $("price-update").textContent = "刷新失败，保留已有价格";
    } finally {
      button.disabled = false;
    }
  });
  load();
  return () => {
    stopped = true;
    clearTimeout(timer);
    $("prices").close();
  };
}
