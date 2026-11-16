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

deepseek-flash是供应商别名，具体版本填入study.json的model_version，记录核对日期与来源。上下文、最大输出、机器、公共资源和业务模型仍需全组统一填写。当前包中的TO_BE_SET代表待登记条件。

本文件记录配置要求；实际供应商响应是否遵守配置由运行证据确认。

- [DeepSeek思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Anthropic兼容协议](https://api-docs.deepseek.com/guides/anthropic_api/)
