# 统一制作模型

用户确认使用 deepseek-flash、高思考。主 Agent、制作方自发委派和内部审阅均按同一模型及 high 档位登记，所有调用计入制作费用。产品实际使用的业务模型由 study.json 的 live_service 字段单独登记。

OpenAI Chat Completions 使用 https://api.deepseek.com/v1/chat/completions，关键请求字段如下。

    {
      "model": "deepseek-flash",
      "thinking": {"type": "enabled"},
      "reasoning_effort": "high"
    }

Anthropic Messages 使用 https://api.deepseek.com/anthropic/v1/messages，关键请求字段如下。

    {
      "model": "deepseek-flash",
      "thinking": {"type": "enabled"},
      "output_config": {"effort": "high"}
    }

Responses API 使用 reasoning.effort="high"。每组在开跑前保留脱敏的最终请求参数与响应模型标识，核对协议、模型和思考档位。请求中的API密钥及Authorization头应去除。

界面选择high后仍须核对实际请求。若客户端自动回退模型或省略思考档位，应记录具体变化，当前运行按配置偏离报告。DeepSeek的Anthropic兼容接口忽略thinking.budget_tokens，高思考通过output_config.effort表达。

deepseek-flash是供应商别名。2026-11-16官方价格页列出 DeepSeek-V4.1-Flash-1017；每轮仍保存响应中的模型标识，供应商换版后的运行不能直接混入同组。制作上下文统一为1,048,576 tokens，单请求最大输出上限统一为32,768 tokens，包含思考和正文。内部短请求可以更少，客户端不得自动扩大上限或切换模型。若客户端无法设置这些条件，在开跑前报告配置偏离。

业务服务也固定 deepseek-flash / enabled / high，单请求最大输出4,096 tokens，地址https://api.deepseek.com/v1。语音角色文本固定为study.json中的live_service_voice_role。真实凭据由操作者在产品正常设置中注入；受控故障测试使用公开测试凭据，与真实服务分开记录。

环境基准、公共资源版本、权限和90分钟/10元条件已经写入study.json。各次运行另填run-environment.json，记录实际机器、Agent版本、构建hash、协议及有效参数。记录实际值，不能把本机基准硬抄成另一台机器的实测信息。通用Agent的版本要由组员在运行当日填写；这属于现场事实登记。

本文件记录配置要求；实际供应商响应是否遵守配置由运行证据确认。

- [DeepSeek思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Anthropic兼容协议](https://api-docs.deepseek.com/guides/anthropic_api/)
- [DeepSeek模型及价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
