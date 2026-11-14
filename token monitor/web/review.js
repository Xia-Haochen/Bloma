import config from "../audit-config.json" with { type: "json" };

export const categories = {
  design: "UI / 交互设计", frontend: "前端实现", backend: "后端 / 数据逻辑",
  setup: "环境与依赖", research: "调研与代码阅读", testing: "测试与验收",
  debug: "排查与修复", delivery: "打包与交付", communication: "沟通与总结",
  mixed: "跨模块", unknown: "证据不足",
};
export const outcomes = { success: "有成果", failed: "失败", partial: "部分完成", unknown: "证据不足" };
const specific = new Set(["design", "frontend", "backend", "debug", "testing", "delivery", "setup"]);

const rules = Object.entries(config.rules).map(([category, [name, target]]) =>
  [category, name && new RegExp(name), target && new RegExp(target)]);

function categoryFor(tool) {
  const name = tool.name.toLowerCase();
  const target = tool.target.toLowerCase();
  return rules.find(([, toolPattern, targetPattern]) => toolPattern?.test(name) || targetPattern?.test(target))?.[0] ?? "unknown";
}

export function review(row) {
  const evidence = row.evidence ?? {text: "", tools: [], source: "none", failure: ""};
  const tools = evidence.tools;
  const failed = tools.filter(tool => tool.state === "failed");
  const positive = tools.some(tool => tool.state === "ok");
  const uncertain = tools.some(tool => tool.state === "unknown");
  const groups = [...new Set(tools.map(categoryFor).filter(group => group !== "unknown"))];
  let category = groups.length > 1 ? "mixed" : groups[0] ??
    (config.phaseCategories[row.phase] ?? "unknown");
  if (row.finding?.category && row.finding.category !== "unknown" && (tools.length || evidence.text) && !specific.has(category)) category = row.finding.category;
  const reason = evidence.failure || failed.map(tool => tool.result || tool.name + " 执行失败").join("；");
  let outcome = "unknown";
  if (evidence.failure) outcome = positive ? "partial" : "failed";
  else if (failed.length) outcome = positive || uncertain ? "partial" : "failed";
  else if (positive && !uncertain) outcome = "success";
  else if (positive && uncertain) outcome = "partial";
  else if (!tools.length && evidence.text && row.finding?.outcome === "success") outcome = "success";
  const description = tools.map(tool => [tool.name, tool.target].filter(Boolean).join(" ")).join("；");
  return {
    category, outcome, reason, evidence,
    purpose: ((tools.length || evidence.text) && row.finding?.purpose) || description || (row.phase === "requirements" ? "整理与确认需求" : "缺少可归属的任务证据"),
    result: reason || ((tools.length || evidence.text) && row.finding?.result) || (positive ? "工具已返回执行结果" : evidence.text || "未记录可验证的结果"),
  };
}

export function needsAudit(row) {
  const { category, outcome } = review(row);
  return category === "unknown" || outcome === "unknown";
}
