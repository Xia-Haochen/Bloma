# 项目约定

## 工程入口与边界

- Bloma 是 Windows Electron 软件生成平台，使用 React / Jotai / TypeScript，Pi 执行持续制作。当前工程入口以 `README.md`、`docs/05_PROJECT_PLAN/README.md` 与实际代码为准；原始设计文档包含已退役的分阶段制作、裁判流程，不据此恢复旧执行器。
- 新项目采用 `software-v1`；现役需求入口在 `main/guide/`，接收、恢复与分发在 `main/orchestration/stages/`，连续制作在 `main/desktop/lean-production.ts`，独立验收及交付在 `main/software/`。历史或冻结项目不得静默迁移。
- 跨进程变更须贯通 `shared/` 类型 → `main/ipc/`（由 `main/ipc.ts` 注册）→ `preload/bridge.ts` → `renderer/`；Renderer 不直接访问 Node、文件系统、密钥或 Agent SDK。
- 渠道能否被执行只看有效协议（`shared/channel-protocol.ts` + 主进程协议注册表），不得按供应商品牌白名单放行或拒绝；Responses / Gemini 未实现执行时必须失败关闭。
- 模型渠道及计量在 `main/platform/llm/`，供应商桥在 `main/platform/upstream/providers/`。渠道密钥只在 main 解密，并通过 Electron safeStorage 加密存入独立的 `bloma-channels.json`，不得混写上游渠道配置或把明文返回 Renderer。
- 保留宿主工具权限、请求费用准入及用量记录；不得为对齐上游绕过这些守卫。运行时存储使用 JSON/JSONL 与文件目录，不引入运行时 SQLite。不得自动恢复暂停的付费试验。

## 开发与验证

- 常用命令：`npm run typecheck`、`npm run build`、`npm run start`。`npm run dev:renderer` 只启动 Vite 网页，不代表真实 Electron/IPC 已验证。
- 定向测试：`npx vitest run --configLoader runner <测试路径> --maxWorkers=2 --minWorkers=1`。完整入口及离线组合见 `package.json`；测试分布在 `tests/unit/`、`tests/integration/` 和 `tests/acceptance/`。
- 配置、执行及持久化测试使用独占临时绝对 `PROMA_HOME`，不得读写真实用户渠道或实验账本。清理只针对本次创建的临时资源；不得覆盖用户已有未提交修改。
- 网页/UI 替身、隔离 Electron IPC、原生桌面及真实模型验证分别报告；离线通过不代表付费效果、干净机器安装或正式交付已完成。不提交依赖目录、构建目录、运行产物、日志与密钥。
- 渠道及角色路由契约、上游比较和验证边界见 `docs/05_PROJECT_PLAN/model-config-upstream-alignment-20261117.md`。

<!-- proma:memory:start -->
## 记忆维护

- **个人层（常驻）**：[user_profile.md](<C:\Users\17359\.proma\memory\user_profile.md>)，跨项目共享，仅记录换个项目也成立的个人背景与稳定偏好。
- **项目护栏层（常驻）**：本文件（AGENTS.md，预算 ≤4000 非空白字符），仅保留不看就会在本项目犯错的子项目结构、常用命令与全局红线；具体模块细节、排障经过和某日状态快照一律下沉到项目 memory/。
- **专题手册层（按需）**：[MEMORY.md](<C:\Users\17359\.proma\agent-workspaces\guide-agent-platform-sprint0\memory\MEMORY.md>) 仅维护一行一条的场景路由索引（预算 ≤3500 字符，不写长篇结论摘要），详细主题按索引按需读取；过期或已合并的存量文件（含历史 project-preferences.md）通过可恢复归档移出有效入口。读取不等于核验，不编造用户事实。
<!-- proma:memory:end -->
