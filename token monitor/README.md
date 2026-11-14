# Bloma Token 用量监测

在 Bloma 桌面应用中打开「设置 → Token 用量」。内置面板由 Electron 主进程提供用量和价格数据，随应用构建，无需 Python。首次进入面板时尝试同步官网价格。

## 独立浏览器版

也可在 Bloma 仓库根目录启动独立版，使用 Python 3.10 或更高版本，无需安装 Python 依赖。

```powershell
python ".\token monitor\server.py"
```

打开 [本机面板](http://127.0.0.1:8766/)。服务每 5 秒读取 Bloma 的本机账本和会话记录，默认使用 `PROMA_HOME`，未配置时使用 `~/.proma`。

```powershell
python ".\token monitor\server.py" --home "C:\path\to\proma-data" --port 9001 --offline
```

`--offline` 跳过启动时的官网请求，仍可从价格面板手动刷新。服务仅监听 IPv4 回环地址。账本和会话文件只读，刷新价格成功后只写入 `PROMA_HOME/token-monitor/pricing-cache.json`。摘要由本机提取用户消息和回复片段，无需模型调用。

## 查询口径

- 项目与起止时间共同筛选请求。按请求开始时间纳入统计，结束时间包含所选整分钟，时间采用浏览器时区。没有模型调用的用户消息也可在逐轮视图中找到。
- 趋势、工作流阶段和供应商／模型三种图表使用同一批筛选结果。勾选项只改变图表展示的 Token 类别。缓存读取、缓存写入、非缓存输入和输出分别统计，全部输入为前三项之和。
- 每次模型查询只累计账本 `query_finished` 中供应商上报的用量。失败重试和缺失用量会标出来，空缺字段显示破折号。
- 新账本记录可标记阶段及关联的对话轮次。历史阶段按已知运行角色映射，缺乏依据时显示「未归类」。缺少明确轮次 ID 时尝试关联请求开始前两分钟内、同一会话的最近用户消息，并显示「轮次关联为推断」。同一运行的后续请求沿用首次关联，无法关联的请求单独显示。
- 阶段包含需求、界面、制作、验证、交付。Bloma 的宿主检查、打包及发布可以在没有模型请求的情况下完成，相应阶段显示 0 Token。

## 价格

在线读取 [OpenAI](https://developers.openai.com/api/docs/pricing)、[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)、[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) 和 [Google](https://aistudio.google.com/docs/pricing) 的公开文本费率。启动时尝试同步，也可以在「模型价格」中手动刷新。按供应商和模型标记来源与日期。官网不可访问或解析失败时使用最近成功的本机缓存，再回退到随仓库附带的快照。OpenAI 部分旧模型来自参考项目 2026-08-24 的快照。

估算使用当前显示的标准基础费率，单位为美元／100 万 Token。DeepSeek 按谷峰费率展示区间，避免在缺少假日或账单信息时选定一个档位。长上下文、特定缓存保留期限、工具收费、订阅套餐和自定义渠道实际费率以供应商账单为准。暂时无法定价的请求保留用量，并显示在可估价覆盖率中。
