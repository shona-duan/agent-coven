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

| 原则 | 做法 |
|---|---|
| **按擅长分工，额度均衡只是附带** | Claude、Codex 都是订阅制、额度有限：两家都合适时给最近用得少的一家，某家快到限额就转另一家。不追求对半。 |
| **便宜的先上** | 中文文案/文档/注释、批量机械修改、样板代码、范围明确的简单 bug、补测试 → 先给 DeepSeek（按量计费，每件通常 < $0.01）。 |
| **Claude 出方案，Codex 执行** | 需求模糊时 Claude 写设计进任务包，Codex 在仓库里一口气做完、跑测试修到绿。 |
| **审查按风险分级，不搞层层审** | low/mid：组长看 diff + 自动检查；只有 high（核心逻辑、安全、数据迁移、大重构）才强制两家大模型参与。 |
| **按轮数决定派不派，不按行数** | 组长自己做预估要 N 轮调用：N ≤ 2 自己做；N ≥ 4 倾向派；N ≈ 3 看说明好不好写。 |
| **修两次不行就换脑子** | 同一问题修两次仍失败，把现象和已试方法交给另一家用全新视角排查，不硬磨第三次。 |

### 为什么小活不该派出去（实测）

组长每次调用都要重读整个会话上下文。在一个约 24 万 token 的长会话里实测：

| 任务 | 组长自己做 | 派给 DeepSeek（含写说明 + 审查） |
|---|---|---|
| 写一篇说明文档 | $0.16，2 次调用 | $0.38，5 次调用（含 1 次返工）+ DeepSeek $0.005 |
| 加一个小命令 | $0.07，1 次调用 | $0.23，3 次调用 + DeepSeek $0.004 |

结论：派活省的是输出，却多出"写说明 → 派发 → 验证 → 审查 → 验收"的往返。
所以 1–2 轮能做完的活自己做；派活时把「写说明 + 派发」「验证 + 初筛 + 审查 + 验收」各压成一次调用；
**换任务开新会话**比任何派活策略都省。

---

## 工作流

```
用户 ──▶ 组长（Claude / Codex）
           │ 1. 写任务包 task.json（brief、write_scope、验收标准、检查命令、risk）
           │ 2. jev.mjs triage   → 建议派给谁、要不要先出方案、风险等级
           ▼
         dsh.mjs run --executor deepseek|codex|claude   （取写入范围锁 + 快照）
           │   deepseek：脚本直接调 DeepSeek Harness
           │   codex/claude：组长在锁内用 codex_task.py / claude -p 派活，再 collect --finish
           ▼
         collect --verify    → 独立跑声明的检查（argv 数组，shell=false）
         jev.mjs screen      → 初筛 diff：越界改动、删除原有行为、安全、半成品
         collect --review    → 组长逐条对照验收标准填审查；high 风险需另一家 cross_review
           │
           ├─ pass     → ACCEPTED
           ├─ rework   → 同一 task id 返工（DeepSeek 默认最多 2 次）
           ├─ takeover → 逐级升级给另一家大模型（实现者与验收者分开）
           └─ block    → 授权/环境/需求不足，说明原因
```

### 硬规则（代码强制）

- **敏感任务绝不下放 DeepSeek**：risk=high，或任务中出现鉴权、登录、密码、token、密钥、加密、签名、权限、支付、计费等词（中英），
  `run --executor deepseek` 直接报 `SENSITIVE_NOT_DELEGATABLE`。误报可写 `sensitive_override: "原因"` 放行并留痕。
- **外部副作用不外派**：提交、推送、发消息、部署、改全局配置由组长在用户确认后亲自做。
- **并发与范围**：同时最多两个 writer，写入范围不能重叠；冲突就排队，不改 id 绕锁。
- **退出码 0 ≠ 通过**：执行结束只会进入 `REVIEW` 或 `BLOCKED`，必须经组长审查才 `ACCEPTED`；执行者自评不算审查。
- **只在明确要求时启用**：`/team-dev`（Claude Code）或 `$team-dev`（Codex）。普通开发请求不会触发。

### Jev 判断员

[TypeSafe Jev](https://typesafe.ai) 只给概率化判断、不写代码，单次通常不到 0.05 美分。
"派给谁 / 要不要升级风险"的规则写在 `scripts/jev.mjs` 代码里，调阈值不必重问模型。
分诊和初筛只是建议：组长可以推翻，但要在审查里写一句原因，方便以后调规则。

---

## 仓库结构

```
skills/team-dev/
  SKILL.md                 # 组长读的流程说明（Claude Code / Codex 共用）
  agents/openai.yaml       # Codex 侧的 skill 元数据
  assets/task.json         # 任务包模板
  assets/review.json       # 审查模板
  references/operations.md # 命令、字段、状态机契约
  references/design.md     # 设计依据与上游参考
  scripts/dsh.mjs          # doctor / run / status / stop / collect / web
  scripts/jev.mjs          # triage / screen
  scripts/verify*.mjs      # 离线回归（假 Harness）
codex_task.py              # 把一个有界任务派给 `codex exec`，日志落 runs/
ledger/                    # 四方 token 账本 → dashboard.html（自己做 vs 派出去哪个划算）
memory/global.example.md   # Claude 与 Codex 共用的"共享记忆"模板
examples/                  # 本机配置示例
```

## 安装

需要 Node.js ≥ 22、Python 3，以及你要用到的 CLI：
[Claude Code](https://claude.com/claude-code)、[Codex CLI](https://github.com/openai/codex)、
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（可选）。

```sh
git clone https://github.com/shona-duan/agent-coven.git ~/agent-hub   # 脚本默认装在 ~/agent-hub

# Claude Code
ln -s ~/agent-hub/skills/team-dev ~/.claude/skills/team-dev
# Codex
ln -s ~/agent-hub/skills/team-dev ~/.codex/skills/team-dev

# 本机配置（DeepSeek Harness 入口与凭据文件路径；凭据内容不进配置）
mkdir -p ~/agent-hub/state/team-dev
cp ~/agent-hub/examples/team-dev-config.example.json ~/agent-hub/state/team-dev/config.json

# 可选：Jev 分诊/初筛
export TYPESAFE_API_KEY=...

# 自检
node ~/agent-hub/skills/team-dev/scripts/dsh.mjs doctor --workspace /path/to/your/repo
```

想让两家共享同一套规则：把 `memory/global.example.md` 复制成 `memory/global.md` 按需修改，
然后在 `~/.claude/CLAUDE.md` 写 `@~/agent-hub/memory/global.md`，并把 `~/.codex/AGENTS.md` 软链到它。

然后在对话里说：`/team-dev 在 ~/my-repo 里实现 xxx`。

## 账本

```sh
node ~/agent-hub/ledger/ledger.mjs task start fix-login --mode delegated --estimate 4 --title "修登录跳转"
node ~/agent-hub/ledger/ledger.mjs task end fix-login --note "DeepSeek 一次过"
node ~/agent-hub/ledger/ledger.mjs build && open ~/agent-hub/state/ledger/dashboard.html
```

读本地 Claude / Codex / DeepSeek 日志，按任务时间窗口归账，按 `ledger/prices.json` 折成等价美元，
记录预估轮数与实际轮数，用来校准"什么时候值得派"。详见 [ledger/README.md](ledger/README.md)。

## 上游与致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：DeepSeek 执行端
- [Aider Architect/Editor](https://aider.chat/docs/usage/modes.html)：设计与编辑分工
- [Superpowers subagent-driven-development](https://github.com/obra/superpowers)：任务契约、逐任务审查、最终整体审查

## 局限

- 文件锁用于协作，不是沙箱；敏感代码仍需系统级隔离。
- `reviewer` 字段是责任标记，不是身份认证。
- 价格表与模型名会过时，按官方价目自行修改 `ledger/prices.json`。
- DeepSeek Harness 处于开发预览期，接口可能变化。
