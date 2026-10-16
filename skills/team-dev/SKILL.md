---
name: team-dev
description: 仅在用户明确要求使用本 Skill（/team-dev 或 $team-dev），或明确要求“多模型协作开发 / 派给 DeepSeek 开发并验收”时启用。Claude 或 Codex 当组长，用 Jev 分诊和初筛，按擅长把开发任务派给 DeepSeek Harness、Codex 或 Claude，带写入范围锁、快照 diff、独立检查和按风险分级的验收。普通开发请求、仅提及 DeepSeek，以及对本 Skill 的讨论、审查或维护均不启动该流程。
disable-model-invocation: true
---

# 多模型协作开发（Claude · Codex · DeepSeek · Jev）

**组长（leader）**＝正在和用户对话的一方（Claude 或 Codex）。组长负责需求、设计、拆分、派活和最终验收；执行者按擅长挑选。
共享规则见 `~/agent-hub/memory/global.md`（分工、额度均衡、记忆规则）。本文件只讲开发流程。

## 启用门禁

> 门禁只管本 Skill 的完整流程（锁、快照、验收状态机）。日常开发里按 `global.md` 规则直接用 `codex_task.py` / DeepSeek 轻量派活，**不需要**用户说 /team-dev。

- 只在用户明确请求时启用；任务复杂、提到 DeepSeek、过去用过，都不构成授权。
- 用户要求解释、修改、安装、检查本 Skill 时，只做维护，不派发任何模型。
- 用户调用过 /team-dev（带不带参数都算）即**本会话启用**，之后的开发活都按本流程判断派不派，直到用户撤回；同一任务内的返工、接手、恢复不重复确认。
- 会话被恢复（`--resume`）或压缩后，SessionStart 钩子 `~/agent-hub/hooks/skill-resume.mjs` 会提醒仍在启用；收到提醒先重读本文件。
- 提交、推送、安装依赖、启动服务、部署不随开发授权自动获得，需另行确认。

## 角色与派活

| 执行者 | 适合 | 入口 |
|---|---|---|
| DeepSeek（优先） | 中文文案/文档/注释/i18n、批量机械修改、样板代码、范围明确的简单 bug、补测试 | `run --executor deepseek`（脚本直接调用 Harness） |
| Codex | 需求已明确、需在仓库内一口气做完并跑测试修到绿 | `run --executor codex` 一条命令跑完（脚本按任务包生成说明、调 `codex_task.py`、自动收集并初筛），直接进 REVIEW；耗时长时用后台运行 |
| Claude | 需求模糊需先理清、跨文件重构/架构、需要解释的工作 | `run --executor claude` 取锁 → 组长亲自做（或用 `claude -p` 派活）→ `collect --finish` |

- 两家都适合时按 profile 里的擅长和额度偏好派；某家报限额或用户说快用完，转给另一家。
- 常用组合：需求不明确时 Claude 出方案（写进任务包 brief），Codex 执行。
- 脚本调用 DeepSeek 和 Codex；Claude 执行由组长在锁内进行。
- **执行者运行期间，组长不在同一工作区写文件**（会被判越界、整轮 BLOCKED）；组长也要改的文件（如需求文档）先写进 write_scope，或等执行者结束再改。

## Jev 判断员（分诊与初筛）

Jev（TypeSafe System One）只给概率化判断、不写代码，只按输入计费且极便宜（单次一般不到 0.05 美分）。判断规则在 `scripts/jev.mjs` 的代码里，不在模型里。需要 `TYPESAFE_API_KEY`；本地区需代理：按 HTTPS_PROXY > AGENT_HUB_PROXY > `~/agent-hub/config.json` 的 proxy 取。

- **派活前分诊**：写好任务包后先跑
  `node "$SKILL_DIR/scripts/jev.mjs" triage --task /abs/task.json`
  得到 `executor`（含组长自己做）、`plan`（是否需 Claude 先出方案）、`risk` 和依据信号。
  这是建议：组长可以推翻，但推翻时在审查 summary 里写一句原因，便于以后调规则。
  `low_confidence=true` 时组长自己判断。
- **审查前初筛**：`collect` 之后、审查之前跑
  `node "$SKILL_DIR/scripts/jev.mjs" screen --run-id run-UUID`
  `attention` 列出要重点看的项（越界改动、删除原有行为、安全、数据风险、半成品）。
  `escalate_to_high=true` 时把任务按 high 处理（需要 cross_review）。
  初筛不核对事实正确性，不能代替组长审查；没有标记也要照常审。
- 分诊和初筛的调用都记入 `~/agent-hub/ledger` 账本（Jev 一栏）。

**派活的成本规律（2026-10-09 实测）**：组长每次调用都要重读整个会话上下文，小活派出去反而更贵。
所以组长 1–2 次调用能做完的活自己做；派活时把“写说明+派发”“验证+初筛+审查+验收”各压成一次调用。

## 硬规则（代码强制，不靠临场判断）

- **敏感任务绝不下放 DeepSeek**：risk=high，或 brief/写入范围/验收中出现鉴权、登录、密码、token、密钥、加密、签名、权限、支付、计费等词（中英），`run --executor deepseek` 直接报 `SENSITIVE_NOT_DELEGATABLE`。确属误报时在任务包写 `sensitive_override: "原因"` 放行并留痕。Jev 分诊用同一词表。
- **有外部副作用的动作不外派**：提交、推送、发消息、部署、改全局配置由组长在用户确认后亲自做；执行者提示词已禁止。

**活的大小**：按“组长自己做预估要几次工具调用 N”判断（≤2 自己做，≥3 且方案已定默认派，见 `rules/collaboration.md`）。派活由脚本自动记账；N≥4 仍自己做才用 `ledger.mjs task note` 记一条。交代里的调用次数用会话计数提示给的实际数，不估。

## 风险分级（决定审查深度）

| risk | 例子 | 审查 |
|---|---|---|
| low | 文案、注释、样板、单文件小改 | 组长看 diff + 自动检查；验收证据可简短 |
| mid（默认） | 普通功能、多文件 | 组长对照每条验收标准认真审 + 一次无上下文审查：`collect` 后跑 `python3 ~/agent-hub/review_task.py --run ~/agent-hub/state/team-dev/runs/<run_id>`（自动选非实现者、不看对话；不要手写审查提示词开子任务） |
| high | 核心逻辑、安全、数据迁移、大范围重构 | 必须有两家大模型参与：实现者是非组长的 Claude/Codex 时已满足；否则（DeepSeek 实现或组长自己实现）需另一家给 `cross_review` |

不要给低风险任务加额外审查；脚本只对 high 强制双人。

## 准备

1. 确认**用户指定**的工作区与目标；没指定工作区只问这一点。读相关代码、仓库 AGENTS.md/CLAUDE.md 和项目记忆（`~/agent-hub/memory/projects/<仓库名>/README.md`）。
2. 只有会改变结果的关键歧义才问用户。
3. 第一次调用前读 [操作与状态契约](references/operations.md)；DeepSeek 执行前运行 `doctor`。缺运行时/凭据时报告原因，不自动安装或改模型设置。

```sh
SKILL_DIR="$HOME/agent-hub/skills/team-dev"
node "$SKILL_DIR/scripts/dsh.mjs" doctor --workspace /用户指定的绝对路径
```

本机配置（dsh 入口、凭据文件、是否需要 Web、期望模型）放在 `~/agent-hub/state/team-dev/config.json`，见 operations.md。文件锁不是沙箱。

## 设计与派发

- 用 [任务模板](assets/task.json) 写可独立执行的任务包：`leader`、`risk`、完整 brief、相关代码入口、约束、精确 `write_scope`、验收标准、检查命令。不要复制整段对话；执行者不继承本会话，相关全局约束要写进 `constraints`。
- 写 `not_done_if`：预判这个任务最容易出现的"看似完成"（改测试让它绿、留占位、悄悄缩小范围、绕过而非修复），越具体越好；DeepSeek 任务尤其要写。
- risk=high 必须写 `blocking_criteria`：开工前定好交叉审查中哪些问题算阻塞，交叉审查只按它判 pass/fail，其余意见记为建议，避免无休止返工。
- `write_scope` 用相对路径，不用 glob；包含可能修改的共享接口、配置、锁文件。
- 同一逻辑任务用稳定 `id`；依赖只能指向同一工作区已验收的任务。
- 可先 `run --task /abs/task.json --prepare` 持久化为 READY（不调用模型）。
- 同时最多两个 writer；只有依赖已验收、范围不重叠才并行。遇 `SCOPE_BUSY` / `SCOPE_PENDING_REVIEW` / `CAPACITY_BUSY` 就排队，不改 id 绕锁。
- 长任务用宿主的后台/等待机制，间隔不超过 60 秒，向用户报告有实质内容的进度。组长可在等待时准备下一项，但不要写正在执行的范围。
- 执行者禁止再创建子 agent、后台任务或调用本 Skill。

## 审查与验收

1. 执行结束只进入 `REVIEW` 或 `BLOCKED`；退出码 0 不等于通过。
2. `collect --run-id ...` 拿快照指纹和 diff；顺着 `previous_run` 看完整任务的累计改动，确认任务开始前的用户改动被保留。
3. 所有写入结束后 `collect --run-id ... --verify` 独立跑检查，再跑 `jev.mjs screen` 初筛。
4. `no_changes: true` 时先查清为什么零改动，不要当作完成。用 [审查模板](assets/review.json) 填本次 `artifact_digest`、需求/质量结论、逐项证据，`reviewer` 必须是组长本人；然后 `collect --run-id ... --review /abs/review.json`。不要拿执行者的自评当审查。
5. high 风险按上表补 `cross_review`（另一家给出的 pass 结论和摘要）。
6. 全部任务通过后，检查它们在当前代码中的相互作用，给出整体结论。`accepted_snapshot_changed` 表示验收后代码又变了，要解释并补验。

## 返工与接手

- 普通问题 `decision=rework`：写清文件、问题、期望行为、复验方式，复用同一 task id 再派发。DeepSeek 默认最多 2 次调用（首轮 + 1 次返工；`deepseek_max_attempts` 可设 1–3）。
- 同一方向连续失败两次，审查里写 `strategy_change`；改任务设计写 `plan_adjustment`（范围只能扩不能缩）。
- **逐级升级**：DeepSeek 用完次数仍需返工，或遇到重复请求解决不了的障碍：`decision=takeover`，默认交给**另一家大模型**（组长 claude → codex，组长 codex → claude），让实现者与验收者分开；`takeover_by` 可指定。不让同一个便宜模型反复磨。然后 `run --executor <takeover_by>`（codex 一条命令跑完；claude 由组长修改后 `collect --finish`）→ `--verify` → 审查。
- 授权、环境或关键需求不足：`decision=block` 并说明。真实问题不能因次数用尽而变成通过。

## 异常与恢复

- 默认单次 30 分钟。超时/取消后终止所属进程组并核对退出，保留已写文件，不盲目重试。
- 范围外改动：暂停同工作区 writer，查清来源，填 `scope_resolution` 再返工；不自动回滚用户文件。
- 恢复：先 `status`，中断的运行 `stop --run-id`，再 collect 核对、重新审查。不删活动锁、不重建 id、不重复已验收工作；不用 `pkill` 之类的广泛终止。

接口、字段、状态机与观测范围见 [操作与状态契约](references/operations.md)；设计来源见 [设计依据](references/design.md)。
