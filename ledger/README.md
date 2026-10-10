# ledger：三方 token 账本

汇总 Claude / Codex / DeepSeek 的 token 用量，按任务时间窗口归账，生成本地页面 `dashboard.html`。
用来回答一个问题：**一件活是自己做划算，还是派出去划算。**

## 用法

```sh
cd ~/agent-hub/ledger
node ledger.mjs task start <id> --mode self|delegated --title "做什么"   # 开始计时
node ledger.mjs task end <id> --note "结果/返工几轮"                    # 结束计时
node ledger.mjs build [--days 14]                                       # 重新生成页面
open ~/agent-hub/state/ledger/dashboard.html
```

- `self`：调度者自己做；`delegated`：派给别人做，调度者只写任务说明和审查。
- `start` 与 `end` 之间三方的**所有**调用都算进这个任务。同一时间只开一个任务窗口；
  如果你同时开着别的 Claude/Codex 窗口在干别的事，它们的消耗也会被算进来。

## 数据从哪来

| 成员 | 来源 | 字段 |
|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | 每条 assistant 消息的 usage；同一 message.id 只计一次 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | `token_count` 事件的累计值做差；`rate_limits` 给出订阅额度百分比 |
| DeepSeek | `prices.json` 里 `dsh_homes` 下的 `sessions/**/session.v4.jsonl.zstd` | 每步 `assistant/message` 的 usage |

## 金额怎么算

`prices.json` 里是各模型的 API 标价（美元/百万 token），把 token 折成“等价美元”，只用于横向比较：

- Claude、Codex 是订阅，实际扣的是额度，不是钱；等价美元越高，说明越耗额度。
- DeepSeek 按量付费，等价美元≈真实花费。
- 价格来自第三方汇总，变动时直接改 `prices.json`。

Codex 额外能看到订阅额度的真实百分比（5 小时窗口、周窗口），任务表里的“Codex 额度”列就是窗口前后的差值。
Claude 本地日志没有额度百分比，只能看 token 和等价金额。

## 输出

- `~/agent-hub/state/ledger/dashboard.html`：总览、任务对照、每日消耗、Codex 额度曲线、最近会话
- `~/agent-hub/state/ledger/data.json`：同一份数据的 JSON
- `~/agent-hub/state/ledger/tasks.jsonl`：任务起止记录
