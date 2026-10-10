# 设计依据

本 Skill 由 `codex-deepseek-leader`（Codex 领导 DeepSeek）改造而来，复用其确定性的调度脚本（预检、锁、快照、检查、状态门禁），不另建 agent runtime。

改造要点（2026-10-09，用户确认）：
- 组长不再固定为 Codex：谁和用户对话谁当组长；Claude 与 Codex 共用这一份 Skill、脚本和状态目录。
- 按擅长派活，顺带均衡 Claude/Codex 的订阅额度（不追求对半）；DeepSeek 能干的先给它。
- 审查按风险分级：low/mid 只需组长审；只有 high 才强制两家大模型参与。用户明确反对简单任务的冗余双重审查。
- 本机环境（dsh 入口、凭据文件、Web、期望模型）改为可配置，不写死某台机器的路径。

上游参考：
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，开发预览期，接口可能变化）
- [Aider Architect/Editor](https://aider.chat/docs/usage/modes.html)：设计与编辑分工
- [Superpowers subagent-driven-development](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)：任务契约、逐任务审查、最终整体审查

控制器是当前组长会话。脚本不冒充任何模型，不做语义审查，也不调用 Claude/Codex；`reviewer` 字段是责任标记，不是身份认证。
默认最多两个 writer、DeepSeek 两次调用后交另一家大模型接手、30 分钟超时，是保守的调度默认值。
文件锁用于协作，不能约束同一用户下的恶意程序；敏感代码仍需系统级隔离。
