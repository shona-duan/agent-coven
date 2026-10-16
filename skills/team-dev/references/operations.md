# 操作与状态契约

## 路径与安装发现

入口是本 Skill 的 `scripts/dsh.mjs`。所有命令使用 Node.js；不执行 `.sh` 安装脚本。

Harness 入口选择顺序（命令行 > 环境变量 > 配置文件 > 默认）：`--dsh-bin` → `DSH_BIN` → 配置 `dsh_bin` → PATH 中的 `dsh` → `~/.local/share/deepseek-harness/node_modules/@deepseek-ai/dsh/lib/bin.js`。
本版接受官方 npm 安装的 Node.js CLI，不支持独立原生可执行文件；不会下载备用运行时。

Harness home：`--dsh-home` → `DSH_HOME` → 配置 `dsh_home` → `~/.dsh`。
`settings.yaml` 不存在时 `doctor` 不报错、不比对模型；只有配置了 `expected_model` 且 settings 存在时才逐项比对 `provider/model/reasoningEffort`，不符报 `MODEL_MISMATCH`。失败时不降级、不修改设置。
首次执行 headless 时，Harness 可能初始化其 headless profile；复用已有 Web 服务的鉴权 API 登记工作区、关联和重命名本流程会话，不自动重启 Web。
每次派发额外使用本次运行目录中的 patch 禁用子 agent/workflow/Ralph/goal/jobs 工具，避免绕过组长的并发控制；不修改 Web profile。

控制状态默认保存到 `~/agent-hub/state/team-dev`，`TEAM_DEV_STATE` 可覆盖，`--state-root /绝对路径` 最优先；后续命令必须使用相同目录，不再依赖其他 home 变量。
该目录与业务工作区必须互不包含，控制文件使用 0600、新建目录使用 0700。不自动删除审计记录。

## 配置

运行时配置来源优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。
配置文件选择顺序：`--config` → `TEAM_DEV_CONFIG` → `~/agent-hub/state/team-dev/config.json`（不存在时使用默认值）。
字段与环境变量对应：`dsh_bin`/`DSH_BIN`、`dsh_home`/`DSH_HOME`、`credential_file`/`TEAM_DEV_CREDENTIAL_FILE`、`web_mode`/`TEAM_DEV_WEB_MODE`、`expected_model`/`TEAM_DEV_EXPECTED_MODEL`。
`credential_file` 必须是绝对路径，JSON 含 `DEEPSEEK_API_KEY`；`expected_model` 为可选的 `{provider, model, reasoningEffort}` 对象；`web_mode` 取 `off|required`。
凭据优先级：环境变量 `DEEPSEEK_API_KEY` > `credential_file` > `dsh_home/.credentials.yaml`；只经环境变量传给 dsh 子进程并脱敏，不写进任务包或报告。

## 六个命令

| 命令 | 输入 | 行为与输出 |
|---|---|---|
| `doctor` | `--workspace`，可选 Harness 参数 | 检查入口、版本、凭据存在性、权限、可选 `expected_model` 比对及 Web 登录/只读列表；JSON，`api_request_made=false` |
| `run` | `--task /task.json`，可选 `--prepare` 或 `--executor deepseek\|claude\|codex` | executor 默认 deepseek；prepare 仅持久化 READY；实际执行校验依赖/范围并取得锁，先返回 run id：deepseek 由脚本直接调用 Harness；codex 由脚本按任务包生成说明并调用 `~/agent-hub/codex_task.py`（不另记账），跑完自动收集进 REVIEW/BLOCKED；claude 进入受监督写入（组长在锁内亲自修改，再以 `collect --finish` 收尾） |
| `status` | 可选 `--run-id` / `--workspace` | 只读查看状态、活动 lease、冲突；单次运行还检查验收后的文件变化 |
| `stop` | `--run-id` | 终止该运行的开发或检查监督进程；孤儿恢复核对 PID 出生时间，不使用名称匹配终止进程 |
| `collect` | `--run-id`，可选下列动作之一 | 收集快照、变更与审查证据；动作执行后输出新的 JSON |
| `web` | `--configure` 或 `--workspace` 或 `--run-id` | 配置 Web 接入、登记工作区或幂等同步已结束的原生会话；不调用 prompt/model |

## Web 工作区接入

Web origin 与启动日志由用户按本机实际监听地址和日志位置配置：先核实真实地址、确认日志属于该实例，不复制他机路径，不自行暴露外网端口。运行 Node 需支持 Zstd；不满足时报告并停止，不自动降级。

```sh
node "$SKILL_DIR/scripts/dsh.mjs" web --configure --web-url http://127.0.0.1:3080 --web-log /绝对路径/deepseek-harness.log
node "$SKILL_DIR/scripts/dsh.mjs" web --workspace /用户指定的绝对路径
node "$SKILL_DIR/scripts/dsh.mjs" web --run-id run-UUID --state-root /该任务的状态目录
```

接入配置默认写到状态目录下的 `web-config.json`（即 `--state-root` 或 `TEAM_DEV_STATE` 指定的 `~/agent-hub/state/team-dev`），`TEAM_DEV_WEB_CONFIG` 可覆盖，`--web-config /绝对路径` 最优先；仅含 origin 和日志路径。`web --configure` 成功才保存配置。脚本读取该 origin 最新启动 token，正常交换短期浏览器 cookie，凭据仅保留在内存；不伪造 cookie、不读取/改变 Web 签名密钥。普通浏览器需用同一进程的启动登录链接进入一次，之后打开干净的 Web 入口。通过浏览器工具打开登录链接，不能把 token 写进交付报告。

`web_mode=required` 时 `run` 要求 Web 在线并登记工作区，然后继续使用独立 headless 进程；`web_mode=off` 时不接 Web。默认：状态目录存在 `web-config.json` 则为 `required`，否则为 `off`；`--headless-only` 最优先关闭 Web。工作结束后，从首条原生用户提示中精确匹配本轮 run id（排除返工引用的旧 id），核对 cwd，再调用官方 `session/create` 的显式 id adopt 接口归入工作区；不创建替代会话、不再次提交 prompt。`session/rename` 使用标题格式 `[组长名] <task-id> · 第N轮 · <状态>`。记录 `web.json` 保存原生 ID、路径、标题和同步状态；`web-audit.md` 提供组长审查索引。Claude/Codex 受监督轮次登记工作区与本地索引，但不会伪造 DeepSeek 会话。

原生持久化使用多帧 Zstd JSONL；逐帧解压后匹配，不能只读首帧。会话体上限 64 MiB；超限、日志截断、匹配不唯一、Host 尚未发现会话或版本接口不兼容时，记录 PENDING，停止同步并报告具体原因。`web --run-id` 可补登记旧运行。Web 已持有的历史会话只读取、登记、重命名，不用 headless 恢复它们。

`web.status=SYNCED` 仅表示记录已关联；`task_status=ACCEPTED` 才是组长已提交的验收状态。同步错误不会把失败改为成功，也不会撤销已经落盘的验收。返回非零/同步 PENDING 时只补同步，不重复 `run`；最终同时核对状态一致。Web 启动日志必须属于所接入实例，并与 headless 共用 DSH_HOME；不直接改 `storages/workspace.json` 或会话 JSONL。Web 正运行的会话不可由本脚本并发接管。

支持 `--headless-only` 明确跳过 Web，专用于离线假 Harness 回归或用户明确要求纯 CLI 的任务。默认派发不允许自动降级。执行中的实时跟踪仍由组长监督器负责，Web 在该轮完成后呈现记录，不保证 headless token 流实时显示。

`collect` 动作一次只能选一个：

- `--finish`：Claude 受监督执行完成写入，释放写入锁并进入 REVIEW；只有正在运行的 claude 任务能用（codex 已由 run 一条命令收尾）。
- `--verify`：在同工作区没有 writer 时，独立执行所有声明的检查。检查使用 argv 数组、`shell=false`，按顺序运行；失败结果保留，不标记 ACCEPTED。
- `--review /review.json`：提交组长的语义审查；核对 run id、快照指纹、必需检查与验收证据，更新状态。

退出码 `0` 表示本命令完成，不意味着检查全部通过或任务通过验收；`1` 表示开发执行失败/被中止；`2` 表示输入、前置条件、恢复或验收门禁失败。读取 JSON 的 `status` 和检查 `results`。

## 任务包

从 `assets/task.json` 复制后填写具体值。字段约定：

| 字段 | 约束 |
|---|---|
| `id` | 稳定标识，以字母/数字开头，允许 `._-`，最长 80 字符；重试不能改 id |
| `leader` | 必填；任务组长，`claude` 或 `codex`；审查 `reviewer` 必须与之一致 |
| `risk` | 可选，`low\|mid\|high`，默认 `mid`；决定审查深度与是否强制 `cross_review` |
| `workspace` | 用户指定且存在的绝对目录；不允许系统根或用户主目录 |
| `brief` | 完整设计及本次开发目标；不能空白 |
| `constraints` / `context_files` | 建议包含适用的全局约束及相关源码入口；写进发给 worker 的任务契约 |
| `depends_on` | 同工作区已验收任务的 id；代码变化导致验收摘要失效时禁止派发 |
| `write_scope` | 非空的相对文件/目录数组；无 glob，无 `..`，不含 `.git`；目录含后代 |
| `timeout_seconds` | 默认 1800；允许 1～43200，在派发前设定 |
| `acceptance` | 非空数组，包含唯一 `id`、`description` 和 `required`（默认 true） |
| `not_done_if` | 可选，非空字符串数组：列出"看似完成其实不算"的情况（改测试让它绿、留占位、缩小范围等）；会单独写进执行者提示词，accept 时要求 `not_done_review` |
| `blocking_criteria` | risk=high 必填，非空字符串数组：交叉审查中哪些问题算阻塞，开工前写定；不在其中的意见记为非阻塞建议 |
| `checks` | 可空；每项包含唯一 `id`、`kind`、`argv`，可选 `cwd`（默认 `.`）、`timeout_seconds`（默认 120，上限 1800） |

检查 `kind` 为 `syntax/typecheck/compile/test/inspection`。不把任意字符串交给 Shell。
脚本拒绝常见的启动应用、执行 `.sh` 和 Java 运行命令，但这不是通用命令安全分析器；组长必须审查实际 argv、项目脚本和授权。
检查不继承 DeepSeek 模型凭据。命令从当前项目已有检查中选择；若需要新增测试代码，遵守用户与仓库规定。

写入范围遇到符号链接或多链接普通文件会拒绝，以免物理路径别名越过归属范围。锁按 NFC 与小写保守归一化；Linux 大小写敏感卷上可能保守串行，macOS 上避免同一物理文件并发写入。
目录/文件重叠时脚本拒绝本次派发，**不会暗中排队或启动**；组长负责等前项完成后继续。

## 状态与审查

`run --prepare` 持久化 READY 并保存任务包，不调用模型。实际 `run` 使 READY → RUNNING，也允许直接运行一个新任务。成功且有非空报告 → REVIEW；超时/错误/空报告/范围异常 → BLOCKED。
组长提交 accept → ACCEPTED；rework/takeover → REWORK；block → BLOCKED。
READY 可首次派发，REWORK 可派发下一轮；ACCEPTED 的重复派发直接拒绝。BLOCKED 要先收集证据并提交 rework 或 takeover。
执行者默认 deepseek，首次派发即可用 claude/codex，不需要先 takeover。状态记录了 `next_executor` 时，本轮必须与之一致，否则报 `EXECUTOR_MISMATCH`。DeepSeek 达到 `deepseek_max_attempts`（默认 2，可经 --deepseek-max-attempts / TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS / 配置设 1–3）后禁止再派 deepseek。

审查 JSON 必填：`reviewer`（必须等于任务 `leader`，即 `claude|codex` 之一）、`run_id`、当前 `artifact_digest`、`decision`、`summary`。
可选 `takeover_by`（`claude|codex`，缺省为 leader），用于 takeover 或 rework 时改换执行者。
风险为 high 且 decision=accept 时：若最后一轮 executor 是非组长的 claude/codex，则无需 `cross_review`；否则必须有 `cross_review={reviewer: 与 leader 不同的 claude|codex, decision: "pass", summary}`，缺失报 `CROSS_REVIEW_REQUIRED`。low/mid 不要求。判断以最后一轮 executor 为准：非组长接手者需读懂并修改前几轮代码，加上组长验收，视为两家参与。
接受还要求 `spec="pass"`、`quality="pass"`、`blocking_findings=[]`，以及每项必需验收的唯一 `id`、`status="pass"`、非空 `evidence`。
任务有 `not_done_if` 时，accept 还要求非空 `not_done_review`，否则报 `NOT_DONE_REVIEW_REQUIRED`。
本轮快照与开始时相比零改动时，`collect` 输出 `no_changes: true`；accept 必须填 `no_change_reason`，否则报 `NO_CHANGES`（防止"报告说做完了、实际什么都没改"）。
`evidence` 应包含实际文件/行号或日志路径以及它如何满足要求，不能只复述结论。

所有任务声明的检查必须由本脚本实际执行并通过，且绑定同一快照。验证过程改变了受审源文件，或验证后再次改代码，会阻止接受，需重新审查/检查。
REWORK 不能直接改为 ACCEPTED；必须经过新的成功开发/接手轮次，防止失败结果被换状态洗成通过。
`reviewer` 不是身份认证：同一用户有能力修改控制文件。因此只有组长能生成/提交审查，不能信任 worker 代填。

返工字段：

- `strategy_change`：连续两次 DeepSeek 调用后，继续前必须说明不同的解决方法；Claude/Codex 接手也应说明具体策略。
- `plan_adjustment`：变更 task.json 中的设计/检查/范围时必须说明原因；范围可扩大，不能在同任务里丢掉以前改过的路径。
- `scope_resolution`：范围异常后说明实际改动来源、如何保留/修复。所有相关 writer 停止后才能解除冲突。

DeepSeek 达到调用上限后，默认由另一家大模型接手（takeover 未指定 takeover_by 时同样默认另一家）。敏感任务（risk=high 或命中敏感词）派 deepseek 报 SENSITIVE_NOT_DELEGATABLE，可用任务字段 sensitive_override 写明误报原因放行。提前接手使用 decision=takeover。超时或监督器失败也计入调用次数，不能无界重试。
rework 后状态记录的 `next_executor`：有 `takeover_by` 用它；本轮是 claude/codex 则保持原执行者；本轮是 deepseek 且次数已满 3 则为 leader，否则 deepseek。
接手示例顺序为 `collect --review`（takeover，`takeover_by` 选 claude|codex）→ `run --executor <takeover_by>`（codex 自动跑完；claude 由组长修改后 `collect --finish`）→ `collect --verify` → `collect --review`（accept）。
已验收依赖出现变化时，可用同样的接手流程进行一次无需模型请求的核对/补验轮次，明确实际变化来源。

## 证据与观测覆盖

每次运行保存 `run.json`、`before/`、`collection.json`、内容寻址的 `snapshots/`、`changes.patch`、检查日志与独立审查历史。
每轮 diff 比对本轮开始前快照。`previous_run` 与 `task_start_run` 用于审查累计改动；最终必须检查整个任务/当前代码的集成结果。
所有备份只供核对，不自动恢复。禁止用广路径复制或 git reset/clean 恢复用户工作区。

受审范围使用 SHA-256 内容摘要和文件权限。上限为单文件 20 MiB、合计 100 MiB，超过时要求拆小任务。
范围外变化监控采用工作区文件清单与 size/mtime/mode；ctime 单独变化不视为代码修改。Git 工作区覆盖 tracked 与未忽略的 untracked 文件；非 Git 工作区递归清单排除 `.git/node_modules/.venv/venv/__pycache__/.DS_Store`，最多 30000 个文件。
因此忽略文件、工作区外写入或刻意恢复相同 size/mtime 的行为**不在强制检测保证内**。本机制是开发协调和审计，不是安全沙箱；不得以文件锁替代系统隔离。

stdout 是 worker 最终报告，不能证明其中声称执行过的命令。stderr 可能包含 provider 推理文本，保存在本地受限日志，不复制到用户报告或下一轮任务上下文。
日志限长并脱敏已知模型凭据及常见 key 格式，但不能保证清除任意业务秘密；任务中不要加入不必要的敏感内容。
本地 headless 未公开服务端实际模型身份时，`response_reported_model=null`，只报告已验证配置。

## 中断恢复与验证工具

先 `status`，对孤儿运行使用 `stop`，再 `collect` 核对文件和未完成动作。PID 出生时间变化时禁止猜测终止对象。无法确认所属进程组退出时保留 lease；不能强行删除以提高并发。
若 registry 锁初始化被中断而缺少 owner 文件，或锁恢复进程中断留下 `.registry.recovery`，工具会返回 `REGISTRY_BUSY`；应由组长检查该专用目录与所有监督进程，再做一次明确的精确恢复，不自动广泛清锁。

运行离线回归：`node <skill>/scripts/verify.mjs /绝对路径/专用验证目录`。它创建假 Harness、临时 Git 夹具和进程，只用虚构凭据，不调用真实 API。不要在业务工作区中运行该验证。
运行 Web 回归：`node <skill>/scripts/verify-web.mjs /绝对路径/专用验证目录`。它仅启动回环地址上的假 Web RPC 和假 Harness，覆盖登录/配置、自动同步、故障恢复、审查标题更新及精确会话关联；不使用真实模型或凭据。
真实模型闭环应另外选择小型临时工作区，在当前授权内执行并记录实际结果；不能把离线回归称为模型能力验证。
