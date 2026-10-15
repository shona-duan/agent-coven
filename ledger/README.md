# ledger：三方 token 账本

自动按会话汇总 Claude / Codex / DeepSeek 的调用数、token、折算金额和涉及仓库，生成本地页面 `dashboard.html`。
用来回答一个问题：**一件活是自己做划算，还是派出去划算。**

## 用法

**小活不记账**，会话统计在 build 时自动生成。手动只记两类：派出去的活用 start/end 窗口；预估≥4轮却仍自己做的活，结束时用一条 task note 记录预估、实际和不派理由。

```sh
cd ~/agent-hub/ledger
node ledger.mjs task start <id> --mode delegated --estimate 5 --title "做什么"
node ledger.mjs task end <id> --note "结果/返工几轮"
node ledger.mjs task note <id> --estimate 5 --actual 8 --why "不派理由" --title "做什么"
node ledger.mjs task list
node ledger.mjs build --days 14                                        # 自动统计并重新生成页面
open ~/agent-hub/state/ledger/dashboard.html
```

- `start` 和 `note` 的 `--mode` 可选，默认 `self`（自己做）；`delegated` 表示派给别人做。
- `task note <id> --estimate N --actual N [--mode self|delegated] [--why 文本] [--title 文本]` 只追加一条记录，不需要 start/end；没有窗口，不归算 token。旧数据里只有 end 的记录也按无窗口展示。
- 预估/实际轮数按手动记录展示，未记录时显示“—”，调用次数不等于实际轮数。
- `start` 与 `end` 之间三方的**所有**调用都算进这个任务。同一时间只开一个任务窗口；
  如果你同时开着别的 Claude/Codex 窗口在干别的事，它们的消耗也会被算进来。
- 会话用量按 `--days` 指定的时间范围累加，按折算金额降序取前 200 条；超过 80 次调用的会话标红。Claude 的仓库从工具参数中的绝对路径提取，Codex/DeepSeek 从 cwd 推断，识别 `~/Desktop/<仓库>` 和 `~/agent-hub`。
- `LEDGER_STATE` 可覆盖状态目录，默认仍为 `~/agent-hub/state/ledger`。测试写记录时使用临时目录，例如 `LEDGER_STATE=/tmp/ledger-test node ledger.mjs task note test --estimate 5 --actual 8 --why 测试`；后续 build 也需使用同一环境变量。

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

- `~/agent-hub/state/ledger/dashboard.html`：总览、任务对照、每日消耗、Codex 额度曲线、会话消耗排名
- `~/agent-hub/state/ledger/data.json`：同一份数据的 JSON
- `~/agent-hub/state/ledger/tasks.jsonl`：任务起止和 note 记录

## 自动记账与防补记（2026-10-14）

- `codex_task.py` 派活时自动 `task start/end`（id=运行目录名，mode=delegated），窗口就是 Codex 实际运行时间；只覆盖 Codex 执行，不含组长写说明和验收的消耗（那部分在会话统计里）。
- DeepSeek 两条路径同样自动记：team-dev `dsh.mjs run`（id=run-…，执行者=组长时记 self，结束 note 为最终状态；找不到 ledger.mjs 时跳过，可用 `AGENT_HUB_LEDGER` 指定）和 `~/dsh-trial/run_task.py`（id=ds-运行目录名）。
- 手动 `task end` 时若没有 start 或窗口不足 2 分钟会被拒绝，提示改用 `task note`；确属真实短窗口加 `--force`。
