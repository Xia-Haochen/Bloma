# 向导 Agent 多智能体协同开发平台

Windows Electron 软件生成平台，使用 Pi 执行持续制作与委派。

当前接手入口（2026-11-07）：[计划与实施索引](docs/05_PROJECT_PLAN/README.md)。新项目使用 `software-v1`；代码与验证证据优先于历史设计。

- [软件工程基线](docs/03_ARCHITECTURE/software-engineering-baseline.md)：负责人 Agent 工程工作循环、产品 Git 管理、恢复检查点及有依据的工程审阅；历史产品问题和实际验证边界在同一入口保留。

- [免费验收与检查入口清算](docs/05_PROJECT_PLAN/offline-clearance-20261105.md)：静音验收器、统一离线检查及本次真实基线复查；真实静音增量和正式交付仍未完成。
- [验收会话交接](docs/05_PROJECT_PLAN/session-handoff-acceptance-20261105.md)：当前涂鸦项目、费用暂停、收尾顺序与完成标准。
- [验收职责收敛](docs/05_PROJECT_PLAN/verification-architecture-refactor-20261105.md)：统一证据解释与Agent反馈，保留宿主交付守卫。
- [质量协作交接](docs/05_PROJECT_PLAN/session-handoff-quality-20261030.md)：Q1–Q4已接线；读取顶部更新，旧正文仅为历史快照。
- [模板交接](docs/05_PROJECT_PLAN/session-handoff-templates-20261029.md)、[UI交接](docs/05_PROJECT_PLAN/session-handoff-ui-20261101.md)：对应专题的实现与验证边界。

历史回归和真实模型收益分别记录；本地CI入口通过不代表远端分支保护、安装验收或真实任务已经交付。

---

## 1. 项目目的

本项目把 Proma 改造为面向零基础用户的软件生成平台。用户不需要理解代码、架构、数据库或测试，只需要用自然语言说明想法，并通过预览确认结果。

核心体验：

```text
两道门选择
→ 整理并确认本轮短任务单
→ 按需要确认静态界面方向
→ 连续实现、试用与局部修复
→ 宿主独立运行 GUI/CLI、能力与交付检查
→ 快速型交付；长期型确认当前里程碑后发布
→ 保留版本与数据，下一轮范围另行确认
```

平台先整理需求，再由持有持续上下文的制作负责人实现与修复；可按明确归属委派子任务。宿主独立裁定验收结果。第二个验收模型默认关闭，需要明确配置与预算；语音等能力复用成熟运行时与资源。

---

## 2. Proma Core 对齐原则

当前实现保留以下平台边界：

- IPC 四层链路：`shared/types.ts -> main/ipc.ts -> preload/bridge.ts -> renderer atoms`。
- Renderer 不直接访问 Node.js、文件系统、API Key 或 Agent SDK。
- API Key 只在 main 进程解密，并通过 Electron `safeStorage` 加密保存到 `bloma-channels.json`。
- Agent 流式输出通过 `AgentOrchestrator -> AgentEvent -> IPC -> Jotai atomFamily(sessionId) -> UI`。
- 工具权限使用 `canUseTool()` + `pendingRequests Map` + UI 决策回传。
- 运行时存储只使用 `~/.proma/` 下的 JSON、JSONL 和工作区文件目录。
- SQLite 只允许作为科研离线导出格式，不进入运行时架构。

---

## 3. 原始设计资料导航（历史）

### 3.1 需求层

| 文档 | 说明 |
|---|---|
| `user-stories.md` | 35 条用户故事，覆盖用户、向导 Agent、编程 Agent、裁判 Agent、研究者 |
| `glossary.md` | 核心术语表 |

### 3.2 UX 层

| 文档 | 说明 |
|---|---|
| `sitemap.md` | 页面树、页面说明、全局 UI 元素和技术边界 |
| `user-flows.md` | 端到端用户流程 |
| `design-system.md` | 视觉、组件、状态和文案规范 |
| `interaction-spec.md` | 模式选择、点选纠错、快照回滚、等待反馈等交互规格 |
| `wireframes/` | 6 个 HTML 线框原型 |

### 3.3 架构层

| 文档 | 说明 |
|---|---|
| `architecture.md` | 总体架构、Proma fork 策略、Agent、沙箱、快照、MCP |
| `component-design.md` | 12 个核心模块设计 |
| `prompt-engineering.md` | 向导/编程/裁判 Agent Prompt 结构和 Proma core 运行边界 |
| `data-model.md` | Local-First 存储、实体、埋点、权限、渠道 |
| `class-diagram.puml` | Proma core 对齐后的核心类图 |
| `sequence-diagrams/` | 5 个关键时序图 |

### 3.4 接口层

| 文档 | 说明 |
|---|---|
| `api-spec.md` | IPC、Renderer Bridge、Agent 流、权限、项目、沙箱、快照、文档、埋点、MCP 工具和错误码 |

### 3.5 测试层

| 文档 | 说明 |
|---|---|
| `test-plan.md` | 测试分层、Mock 策略、CI、发布门禁 |
| `testing-standards.md` | 功能域、测试 ID、文件写法、结果分类和测试报告规范 |
| `features/` | 6 个 GWT Feature 文件 |

Feature 文件：

- `features/mode-selection.feature`
- `features/generation-workflow.feature`
- `features/point-correction.feature`
- `features/timeline-rollback.feature`
- `features/self-healing-judge.feature`
- `features/proma-core-boundary.feature`

### 3.6 计划层

| 文档 | 说明 |
|---|---|
| `sprint-plan.md` | Phase 1 四个 Sprint，固定三人分工，交付物和验收标准 |
| `research-plan.md` | 研究问题、实验设计、指标体系、13 类埋点映射、论文大纲 |

### 3.7 状态文件

| 文档 | 说明 |
|---|---|
| `07_VERSIONS/changelog.md` | 版本变更记录（当前状态与剩余工作以 changelog + git log 为准） |

---

## 4. 当前工程入口

- 接收、恢复与流程分发：`main/orchestration/stages/`；composer持久回执绑定实际执行。
- 连续制作与交付：`main/desktop/lean-production.ts`、`main/software/`；需求确认、候选版本、独立检查和最终交付分别记录。
- Pi运行时与委派：`main/agent/loop/pi-runtime.ts`、`main/agent/delegation/`；宿主权限和费用边界不交给模型自报。
- 模型渠道与计量：`main/platform/llm/`；供应商传输桥保留请求准入、图片授权及用量记录。
- 界面、桥与类型：`renderer/`、`preload/bridge.ts`、`shared/`。

旧分阶段制作、静态网页预览和裁判流程已退出现役入口，历史原始文档不作为当前发布门禁。当前验证范围见本页顶部的工程实施记录；模型效果、原生UI、本机交付和干净机器验收分别说明。

---

## 5. 开发与测试环境

### 5.1 环境准备

- Node.js 22.13 或更新版本（本次验证使用 24.12.0），npm 10 或更新版本（本次验证使用 11.6.4）。
- Windows 10/11；Electron 动态验收需要桌面会话。
- 首次拉取后执行 `npm ci`，依赖版本以 `package-lock.json` 为准。
- 不提交 `node_modules/`、`dist/`、`dist-main/`、`coverage/`、`test-results/`、`.vitest/`、`.proma-test/` 或日志文件。
- 新增或升级依赖时提交 `package.json` 和 `package-lock.json`，不要提交安装目录或构建产物。

### 5.2 主要依赖

| 用途 | 依赖 |
|---|---|
| 桌面运行 | Electron |
| Renderer | React、React DOM、Jotai |
| 类型与构建 | TypeScript、Vite、esbuild |
| 自动化测试 | Vitest、Testing Library、jsdom、Playwright Electron |

### 5.3 验证命令

```bash
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:regression:sprint0
npm run test:regression:sprint1
npm run test:acceptance:sprint0
npm run test:acceptance:sprint1
npm run test:acceptance:sprint2
npm run test:acceptance:sprint3
npm run test:electron-smoke
npm run test:all
npm run docs:check
```

测试写入文件时必须使用临时 `PROMA_HOME`，完整规则见 `docs/06_TESTS/testing-standards.md`。

## 6. 原始文档修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，建立项目总览、文档导航、Proma core 约束、三人分工、实现顺序和发布门禁 |
| v1.1 | 2026-07-25 | 增加测试编写与报告规范导航 |
| v1.2 | 2026-07-25 | 增加开发依赖、测试命令和 Git 产物边界说明 |
| v1.3 | 2026-07-25 | 增加 Sprint 1 Playwright Electron E2E 命令与依赖 |
