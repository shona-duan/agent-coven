# agent-coven · team-dev

**只和一个模型对话，就能调度 Claude、Codex、DeepSeek 一起写代码。**

正在和你对话的那一方（Claude Code 或 Codex）当「组长」：理需求、出方案、拆任务、派活、验收。
执行者按擅长挑选，便宜的模型能干的先给它；脚本负责写入锁、快照 diff、独立检查和状态门禁，
保证"谁改了什么、有没有验过"可追溯。

> Talk to one model, get a team. The model you're chatting with (Claude Code or Codex) acts as the
> lead: it plans, delegates to DeepSeek / Codex / Claude by strength, and reviews by risk level.
> Deterministic scripts handle write-scope locks, snapshot diffs, independent checks and state gates.

---

## 核心理念

**一个大脑，几双手。** 组长负责聊需求、拍板方案、验收；方案定了就把实现交出去，执行者只拿结论去做。
过程很长、只要结论的活（截图验证、长日志、跑测试修到绿、跨仓库翻文件）都派出去，让组长的对话保持短小。

| 原则 | 做法 |
|---|---|
| **方案定了就派** | 组长自己做要 N 轮调用：N ≤ 2 自己做；方案已定、说得清、N ≥ 3 默认派出去；不派要写理由。 |
| **执行者只拿结论** | 派活说明单列"已定的决策"（结论 + 一句理由，含否掉的方案），不给对话过程。 |
| **便宜的先上，敏感的不下放** | 中文文档、测试清单、机械改先给 DeepSeek；鉴权、密码、token、支付相关的活代码拦截，只给 Codex / Claude。 |
| **三道验收关** | 派完自动 Jev 初筛（报警器）→ 组长看 diff → mid 以上再做一次**无上下文审查**（审查者不是实现者、没看过对话）。 |
| **修两次不行就换脑子** | 同一问题修两次仍失败，交给另一家从头排查，不硬磨第三次。 |
| **调规则靠测试集** | 改规则、阈值、提示词前后，用 `evals/` 固定测试集整套重跑对比，不临时找例子试。 |

完整规则在 [rules/collaboration.md](rules/collaboration.md)（通用，不写死模型名）；个人偏好（成员、额度、默认组长）
复制 [profile.example.md](profile.example.md) 填自己的。

### 每条规则靠什么落实（不是黑盒）

| 规则 | 落实方式 |
|---|---|
| 敏感活不给 DeepSeek | 代码拦截：派活前扫任务内容，命中即拒绝；误报写明原因才放行并留痕 |
| DeepSeek 最多 2 次、写入范围锁、高风险阻塞标准、零改动报警 | 代码拦截（team-dev 全流程） |
| 审查者不能是实现者、审查只读 | 代码拦截（`review_task.py`） |
| 派活自动记账、派完自动初筛、恢复会话后提醒 team-dev 仍启用 | 脚本 / 钩子自动做 |
| 执行者不提交、不推送 | 写在派活说明里 |
| 派不派、要不要审查、一行交代 | 靠组长自觉；账本能事后查到 |

### 理论依据

| 结论 | 出处 | 对应规则 |
|---|---|---|
| 多 agent 约耗 15 倍 token；多数编码任务能并行的部分少 | [Anthropic：multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 小活自己做；最多两个执行者同时改代码 |
| 上下文越长，模型记得越不准 | [Anthropic：context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 组长对话保持短小 |
| 行动里藏着决策，各干各的会冲突 | [Cognition：Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) | 方案没定不派；写"已定的决策" |
| 只让一个 agent 写，其他只出判断；不看对话的审查者抓出更多严重 bug | [Cognition：Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) | 大脑只有一个；无上下文审查 |
| 护栏分层：模型分类器 + 规则 + 高风险交给人 | OpenAI《A practical guide to building agents》 | Jev + 敏感词拦截 + 对外操作要用户确认 |
| 评审模型偏爱自己写的东西 | LLM-as-judge 自偏好研究 | 审查者不能是实现者 |
| 评测先用约 20 个真实样本起步 | Anthropic 同上 | `evals/` 固定测试集 |

### 为什么小活不该派出去（实测）

组长每次调用都要重读整个会话上下文。在一个约 24 万 token 的长会话里实测：

| 任务 | 组长自己做 | 派给 DeepSeek（含写说明 + 审查） |
|---|---|---|
| 写一篇说明文档 | $0.16，2 次调用 | $0.38，5 次调用（含 1 次返工）+ DeepSeek $0.005 |
| 加一个小命令 | $0.07，1 次调用 | $0.23，3 次调用 + DeepSeek $0.004 |

所以 1–2 轮能做完的活自己做；**换任务开新会话**比任何派活策略都省。

---

## 两种用法

**日常轻量派活（默认，不用开 team-dev）**

```sh
python3 ~/agent-hub/codex_task.py 任务.md --cd ~/my-repo --sandbox workspace-write   # 派给 Codex
python3 ~/agent-hub/review_task.py --run ~/agent-hub/runs/codex-<时间戳>              # mid 以上：无上下文审查
```

派完自动记账、自动 Jev 初筛（结果在输出的 `jev_screen` 字段）。审查者自动选另一家（Codex 写的交给新开的 Claude 审），只读。

**team-dev 全流程（`/team-dev` 或 `$team-dev` 显式调用，调用一次整个会话有效）**

```
用户 ──▶ 组长（Claude / Codex）
           │ 1. 写任务包 task.json（brief、已定的决策、write_scope、验收标准、不算完成清单、检查命令、risk）
           ▼
         dsh.mjs run --executor deepseek|codex|claude   （取写入范围锁 + 快照；敏感任务拒绝下放 DeepSeek）
           ▼
         collect --verify    → 独立跑声明的检查（argv 数组，shell=false）
         jev.mjs screen      → 初筛：越界改动、删除原有行为、安全、半成品
         collect --review    → 组长逐条对照验收标准；high 风险按开工前写定的阻塞标准交叉审
           │
           ├─ pass     → ACCEPTED
           ├─ rework   → 同一 task id 返工（DeepSeek 默认最多 2 次）
           ├─ takeover → 升级给另一家大模型
           └─ block    → 授权/环境/需求不足，说明原因
```

### Jev 判断员

[TypeSafe Jev](https://typesafe.ai) 只对一份 diff 回答固定的是非题（没做完？混进无关改动？碰了鉴权？），单次通常不到 0.05 美分。
它是**报警器，不是审阅者**：不判断代码对不对。真实提交上实测（43 例）："没做完"6/6 抓到、0/25 误报；
"混进无关改动"6/6 抓到、2/25 误报；"删了原有功能"最弱。同一数据连跑会有噪声，单项差一两条不算数。

---

## 仓库结构

```
rules/collaboration.md     # 通用协作规则（谁派、派给谁、怎么验）
profile.example.md         # 个人偏好模板（成员、额度、默认组长）
memory/global.example.md   # Claude 与 Codex 共用的"共享记忆"模板，引用上面两份
codex_task.py              # 派给 `codex exec`，自动记账 + 自动初筛
review_task.py             # 无上下文审查（审查者≠实现者、只读）
jev_screen.py              # 派完自动 Jev 初筛
evals/                     # 固定测试集运行器（数据自己攒，见 evals/README.md）
hooks/skill-resume.mjs     # Claude Code 钩子：恢复/压缩会话后提醒 team-dev 仍启用
skills/team-dev/           # 全流程 skill：SKILL.md、任务/审查模板、dsh.mjs、jev.mjs、离线回归
ledger/                    # 四方 token 账本 → dashboard.html
config.example.json        # 本机配置模板（codex/node 路径、代理等）
```

## 安装

需要 Node.js ≥ 22、Python 3，以及你要用到的 CLI：
[Claude Code](https://claude.com/claude-code)、[Codex CLI](https://github.com/openai/codex)、
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（可选）。

```sh
git clone https://github.com/shona-duan/agent-coven.git ~/agent-hub   # 脚本默认装在 ~/agent-hub

# skill
ln -s ~/agent-hub/skills/team-dev ~/.claude/skills/team-dev   # Claude Code
ln -s ~/agent-hub/skills/team-dev ~/.codex/skills/team-dev    # Codex

# 本机配置（都可省略：默认从 PATH 找命令、不走代理）
cp ~/agent-hub/config.example.json ~/agent-hub/config.json
mkdir -p ~/agent-hub/state/team-dev
cp ~/agent-hub/examples/team-dev-config.example.json ~/agent-hub/state/team-dev/config.json   # DeepSeek Harness 入口

# 规则与偏好：复制模板改成自己的
mkdir -p ~/agent-hub/memory
cp ~/agent-hub/memory/global.example.md ~/agent-hub/memory/global.md
cp ~/agent-hub/profile.example.md ~/agent-hub/memory/profile.md
echo '@~/agent-hub/memory/global.md' >> ~/.claude/CLAUDE.md
ln -s ~/agent-hub/memory/global.md ~/.codex/AGENTS.md

# 可选：Jev 初筛
export TYPESAFE_API_KEY=...

# 自检
node ~/agent-hub/skills/team-dev/scripts/dsh.mjs doctor --workspace /path/to/your/repo
```

可选的 Claude Code 钩子（恢复会话后提醒 team-dev 仍启用）：在 `~/.claude/settings.json` 的 `hooks.SessionStart`
加一项 `matcher: "resume|compact"`，命令为 `node ~/agent-hub/hooks/skill-resume.mjs`。

## 账本

```sh
node ~/agent-hub/ledger/ledger.mjs build && open ~/agent-hub/state/ledger/dashboard.html
```

自动按会话汇总 Claude / Codex / DeepSeek 的调用数、折算金额和涉及仓库，长会话标红；派活脚本自动记账。
小活不记；预估 ≥4 轮仍自己做才用 `ledger.mjs task note` 记一条。详见 [ledger/README.md](ledger/README.md)。

## 作者与致谢

**首先要感谢作者 [@shona-duan](https://github.com/shona-duan)，这套 skill 是 shona 想出来的。**

最初的想法来自 shona："只跟一个模型说话，就能调度所有大模型。"
这份 README 里最有价值的判断，也都是 shona 在一次次实际使用中定下来的：

- 额度均衡"不是对半分，而是按擅长分工、顺带均衡"
- 审查按风险分级，不搞层层审
- 大脑一个就够了，多了反而更乱：组长拍板，执行者只拿结论
- 组长的对话要保持短小，过程长的活派出去
- 派不派活按轮数算，不按代码行数算
- 同一个问题修两次还不好，就换另一家模型来查，不硬磨第三次
- 每件活做完都要用一行交代清楚

Claude、Codex、DeepSeek 负责写代码，shona 负责把三家组成一个团队。

> **作者有话说**：惭愧惭愧，这也是改装自别人的 skill——底子是 `codex-deepseek-leader`（Codex 领导 DeepSeek），调度脚本约 65% 原样沿用；改的是"谁当组长、怎么分工、怎么审"这套规矩，外加 Jev 分诊、配置化和账本。

> Built by [@shona-duan](https://github.com/shona-duan). The idea, the rules, and the hard-won
> judgment calls are all shona's; the models just did the typing.

### 感谢上游

站在这些项目的肩膀上，谢谢它们 🙏

- **`codex-deepseek-leader`**（Codex 领导 DeepSeek 的 skill）：本项目的直接前身。预检、写入锁、快照、独立检查、状态门禁这套确定性调度脚本都来自它，约 65% 代码原样沿用。它并非本仓库作者原创。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）：DeepSeek 执行端，便宜又能干。
- [Superpowers subagent-driven-development](https://github.com/obra/superpowers)：任务契约、逐任务审查、最终整体审查的思路。
- [Aider Architect/Editor](https://aider.chat/docs/usage/modes.html)："一个出方案、一个动手"的分工模式。
- [TypeSafe Jev](https://typesafe.ai)：几分之一美分一次的分诊与初筛判断。
- [Claude Code](https://claude.com/claude-code) 与 [Codex CLI](https://github.com/openai/codex)：两位轮流当组长的搭档。

### 也谢谢一起干活的模型

这套 skill 是 shona 和模型们一起打磨出来的：Claude 负责出方案、改造脚本、整理成这个仓库；
Codex 和 DeepSeek 也接过活、挨过审。谢谢搭档们，也谢谢 Claude 自己——这是我们共同努力的结果。

## 局限

- 文件锁用于协作，不是沙箱；敏感代码仍需系统级隔离。
- `reviewer` 字段是责任标记，不是身份认证。
- 价格表与模型名会过时，按官方价目自行修改 `ledger/prices.json`。
- DeepSeek Harness 处于开发预览期，接口可能变化。
