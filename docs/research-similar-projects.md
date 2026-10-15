# 8 个多 agent 协作项目 README 调研笔记

背景对照：我们已有多模型协作（Claude 组长/设计、Codex 执行/备用、DeepSeek 便宜执行、Jev 极便宜分类判断），以及共享记忆文件、任务包+写入范围锁+快照 diff+独立检查+按风险分级验收的派工脚本、按"预估调用轮数"决定自己做还是派出去、token 账本。以下只写各 README 中有依据的内容，没有依据的写"未提及"。

## awslabs_cli-agent-orchestrator（CAO）
- 一句话定位：AWS Labs 的多 CLI 编排器，本地跑 `cao-server`，在隔离终端会话中拉起多种 provider CLI，由 supervisor 把工作并行或顺序派给专职 agent。
- 怎么分派任务：由 supervisor 借助一组协调 worker 的工具分派，README 只说明 supervisor 能派给 specialist agents、支持并行/顺序以及 flows/workflows 编排；"谁决定派给谁、依据什么"未提及。
- 质量把关：仅在机器人示例中提到"measured custody handoffs 和 independent checks"，另有 self-learning 把工作流结果转成 lessons；具体审查、测试、回退机制未提及。
- 成本/额度控制：未提及（没有 token 统计或按成本路由的描述）。
- 上下文/记忆怎么在多个 agent 间传递：提供持久化跨会话 memory，以及 opt-in 的 self-learning 循环，把工作流结果变成 lessons 并提升为 instructions；Kubernetes 部署示例提到共享 workspace + per-pod state。
- 值得我们借鉴的 1–3 个具体做法：1）持久跨会话记忆 + "工作流结果→lessons→promoted instructions"的自学习闭环，可用来演进我们的共享记忆文件，让派工结果反过来改规则；2）agent profile 的 provider selection/overrides 与 tool restrictions 的 roles/allowlists/provider enforcement，思路接近我们的写入范围锁与风险分级，可补一层"角色能碰什么工具"的机器可读约束。
- 我们已经有、或不适合我们的：它是 server+tmux+Web UI 的重量级平台，对我们自建脚本栈过重；但记忆闭环和角色限制两块可直接借鉴。

## imkunal007219_claude-coworker-model（Claude Coworker Model）
- 一句话定位：把批量 I/O 从 Claude Code 卸载到便宜 LLM（Kimi/DeepSeek/Ollama 等 OpenAI 兼容 provider），给 Claude 省 token。
- 怎么分派任务：Claude 决定 *what*、worker 负责 *reading/writing*；由项目根目录 `CLAUDE.md` 里的 "Worker Delegation Rules" 规定何时 delegate（跨多文件分析/总结/搜索、生成 boilerplate/tests/docs 时派），并明确列出架构决策、复杂调试、重构计划"不派"。
- 质量把关：未提及（README 没有审查、测试或回退机制）。
- 成本/额度控制：有。worker 调用约 $0.02；`ask-kimi`/`kimi-write` 用 `--max-tokens` 设总预算（含 reasoning tokens）；结果表称 Claude Pro 周额度从"周三用完"变成"从未用完"，单 session token 花费从 80% 在读文件降到 20%，3 周 worker API 总花费 $0.38。
- 上下文/记忆怎么在多个 agent 间传递：靠显式传参而非持久记忆——`ask-kimi --paths` 把文件内容交给 worker，`kimi-write --context` 用参考文件固定风格，`extract-chat` 把 Claude Code 的 JSONL session 转成文本再喂给 `ask-kimi`。
- 值得我们借鉴的 1–3 个具体做法：1）用 `CLAUDE.md` 式标准策略块写明"该派/不该派"清单，可直接套到我们组长 Claude 的派工规则上，成本极低；2）`extract-chat` 把 session transcript 转文本再交给便宜模型做文档更新，正是"便宜模型吃 context、贵模型做决策"的可落地模式；3）每个便宜调用强制 `--max-tokens` 预算帽，并让生成类任务带参考文件，保证风格一致。
- 我们已经有、或不适合我们的：我们已按"预估轮数"决定自己做还是派出去，比它按固定任务类型分派更细；它的工具是单次调用脚本，缺少我们的写入范围锁、快照 diff 和独立检查。

## jig21nesh_model-switcher（model-switcher）
- 一句话定位：Claude Code 本地会话的 per-prompt 模型路由 + 离线确定性成本追踪：简单 prompt 留在便宜的 session model，复杂 prompt 委托给 `heavy-task-*` 子代理跑更强模型。
- 怎么分派任务：`UserPromptSubmit` hook 在 Claude 看到 prompt 前本地打分 0–10（手写信号：任务动词 5 分、领域词各 +1、stack trace +3、多步列表 +2 等；词汇只看前 80 词、结构信号读前 10 KB），达到 `complexity.threshold` 就注入强制委托指令；三档 simple/standard/complex 分别对应会话内/`mid-task-*`/`heavy-task-*`；`PreToolUse` hook 还会拦截 Claude 自己 spawn 的 `general-purpose` agent，按同一打分改写到对应 tier（只升不降、只对 general-purpose/claude、排除 Explore、只限顶层 spawn、绝不改写成不存在的 agent）。可选 Jev 独立评估（默认关，min_confidence 0.7、3s 超时、低置信/超时/报错一律回退离线结果）。
- 质量把关：路由用两层强制（per-prompt directive + `CLAUDE.md` 的 standing policy block），statusline 当审计线索（复杂轮只按便宜模型计费说明 delegation 被跳过）；hook fail-open，缺失/损坏的 classifier 被忽略后照常路由；安装是 merge-based 可逆，uninstall 按 manifest 恢复原 settings/statusline；CI 有 80% 每文件行+分支覆盖率下限，另有约 50 个生命周期场景测试。对"输出代码本身"的审查/测试未提及。
- 成本/额度控制：有，且很细。statusline 离线解析本地 `.jsonl` transcript（含每个子代理自己的文件），按 config 的 `pricing_usd_per_mtok` 算 turn/session 成本，cache write 按 5 分钟 TTL 与 1 小时 TTL 分别计价、`usage.speed=="fast"` 走 fast 价；`saved` 段是用"本会话实际用过的最贵模型"重定价的反事实，且单模型会话不显示节省；`pricing` 命令可离线比对/应用维护中的价表。路由到便宜模型完全由打分阈值决定，无网络调用。
- 上下文/记忆怎么在多个 agent 间传递：委托时通过 Agent/Task tool 把完整 task + context 传给 tier 子代理，结果 relay 回主会话；`~/.claude/CLAUDE.md` 里 marker 分隔的 routing policy block 是跨 turn 的常驻规则；学习出的 `classifier.json` 跨会话保留（uninstall 也保留）；项目级 `.claude/model-switcher.json` 只能 disable，用户级 `project_settings` 才可按绝对路径覆盖阈值。
- 值得我们借鉴的 1–3 个具体做法：1）把"为什么这样路由"做成 `explain`——打印决策边界、离阈值多少、哪条信号把它推过去、什么会翻转它，正适合给我们的 Jev 分类判断加可审计性；2）`learn`/`tune` 从自己的 transcript 历史学习权重和校准阈值，先出候选与 before/after 准确率、必须 `--apply` 才生效，还能报告"学到的是难度还是某个项目的主题"；3）成本记账的诚实取向——cache TTL 分开计价、不确定就标 `no rate`/`n/a`、单模型不虚报节省、`saved` 明确是反事实并注明分母，可直接补强我们的 token 账本。
- 我们已经有、或不适合我们的：我们已有 token 账本和按预估轮数派工；它是 Claude Code hook/statusline 专用且依赖 Claude 模型阶梯，不直接适配我们的多厂商组合，可选 Jev 评估还会把 prompt 内容发到外部服务，与我们本地化取向不符。

## kingbootoshi_codex-orchestrator（Codex Orchestrator）
- 一句话定位：用 tmux 会话把任务派给 OpenAI Codex agent，供 Claude Code 编排——可并行 spawn、监控进度、中途发消息纠偏、抓取结果。
- 怎么分派任务：Claude 作为 orchestrator，把请求拆成 agent 大小的任务、按任务性质用合适 flag spawn（研究用 `-s read-only`、实现用 `workspace-write`，`-r` 调 reasoning effort、`-m` 指定模型）、监控并综合多个 agent 的发现、对跑偏的 agent 纠偏；skill 自动激活并走 "Ideation→Research→Synthesis→PRD→Implementation→Review→Testing" 流水线，每阶段配不同 agent 配置。
- 质量把关：有 sandbox 三档（`read-only`/`workspace-write`/`danger-full-access`）；Review 是流水线的一个阶段；可 `capture`/`output`/`attach` 人工查看，`--strip-ansi` 去噪便于解析，dry-run 可预览 prompt；`kill` 仅作最后手段。自动测试与回退机制未提及。
- 成本/额度控制：有统计、无规则。`jobs --json` 输出每个 job 的 `tokens`（input/output/context_window/context_used_pct）、`files_modified`、`summary`；reasoning effort 可分级；但 README 未提及按成本自动路由或预算上限，模型需手动指定（默认 gpt-5.4）。
- 上下文/记忆怎么在多个 agent 间传递：`--map` 把 `docs/CODEBASE_MAP.md` 注入每个 agent 的 prompt，提供文件用途、模块边界、数据流、依赖和导航；`-f` 可附带文件 glob，`-d` 指定工作目录；job 的 metadata/prompt/log 存在 `~/.codex-agent/jobs/`，token 与文件改动从 `~/.codex/sessions/` 的 JSONL 解析。无跨会话记忆描述。
- 值得我们借鉴的 1–3 个具体做法：1）把一份 codebase map 注入每个子 agent，减少它们现场探索的 token 与瞎猜，我们可以给 DeepSeek/Codex 执行者预置同类"仓库地图"；2）`jobs --json` 一次返回结构化的 tokens/files_modified/summary，方便编排方机器化验收而非抓屏；3）用 `send` 中途纠偏而不是 kill+respawn，减少重跑浪费。
- 我们已经有、或不适合我们的：我们已有风险分级验收、写入范围锁和快照 diff；它假设 Codex CLI + tmux 且没有成本路由自动化，与我们已有栈部分重叠。

## OrchestratorInc_agent-orchestrator（Orchestrator.inc）
- 一句话定位：本地桌面工作台，从一处 plan/run/supervise 多个 coding agent——每个任务一个 agent、一个隔离 workspace、一条反馈回路，并以 live Kanban 呈现。
- 怎么分派任务：project orchestrator 是持久规划/协调 agent，工作在单任务之上（产品方向、技术策略、优先级、顺序），把计划拆成 focused tasks、spawn 或 redirect workers、给每个 worker 传相关 context、跟进后续；orchestrator 负责规划与 delegation，worker 负责实现/测试/commit/PR。人工也可从 "New task" 直接派。依据是项目级计划、优先级，以及 live 状态（active workers、ownership、PR、CI、reviews）。
- 质量把关：每个 Git 任务给独立 branch + worktree，避免分支碰撞；Kanban 从 session/PR/CI/review 事实派生状态（Working / Needs you / In review / Ready to merge）；CI 失败和 review 反馈会送回同一个 owner agent 闭环；有 agent reviews 与每 worker 隔离的浏览器 profile。具体自动测试命令未提及（依赖 CI）。
- 成本/额度控制：未提及（没有 token 统计或按成本路由；只说明 telemetry 明确排除代码、prompt、agent 对话和凭证）。
- 上下文/记忆怎么在多个 agent 间传递：project orchestrator 的 project-scoped conversation 持久保存 goals、decisions、constraints 和 earlier reasoning，并叠加 repository context 与 live 状态；给每个 worker 传 focused context；worker 有各自独立 session 上下文，task/对话/终端/改动文件/PR/CI/review 始终挂在 session 上。repo 状态与 telemetry 默认留在本地。
- 值得我们借鉴的 1–3 个具体做法：1）每个任务一个 worktree+branch 的隔离，可在我们写入范围锁之外再加一层 git 级防碰撞；2）把 CI/检查失败与 review 意见回送给"同一个 owner agent"，正是我们独立检查+按风险验收后缺的闭环；3）持久保存 project 级 goals/decisions/constraints，并把它和 live 状态（谁在跑、PR/CI/review）一起喂给规划者，可补强我们的共享记忆文件。
- 我们已经有、或不适合我们的：我们是 CLI/脚本栈，它是桌面 app + 本地 daemon 的重量级方案，也没有按量成本路由；但 worktree 隔离与 review 回送同 owner 两点可直接搬。

## SethGammon_Citadel（Citadel）
- 一句话定位：Claude Code 与 OpenAI Codex 的开源 operating layer——路由请求、在会话间保留 repo 状态、协调并行工作、施加仓库保障，并围绕既有 coding agent 记录 evidence 与 handoffs。
- 怎么分派任务：单一自然语言入口 `/do`；exact commands 仅在规范化后的整个请求匹配时解析，`/do test|build|typecheck` 还要求 `package.json` 有对应非空 script；较大请求先收集 generated candidates 再做 runtime semantic classification；已知目标可用经校验的 `/do --route <skill>` 覆盖。Codex 的 agent model 与 reasoning effort 是项目配置（默认 Sol/Terra/Luna，支持 per-family/per-agent 覆盖），非硬编码。
- 质量把关：核心是 Evidence 契约，报告 `passed`/`failed`/`blocked`/`unknown`，且明确"missing evidence 不升级为 success"；`Needs You` 状态停下并指出确切的 approval/conflict/缺失证据；跑不动就 fail-honest，没执行的 preview 明确 `canRunNow: false`。它会发布正反两面的实验结果并声明局限（例如 baseline 失效、不宣称省成本），并明确不替代 `CLAUDE.md`、`AGENTS.md`、branch protection 和人工 review。
- 成本/额度控制：有实验性成本对比而非实时账本：bounded hybrid pilot 中本地 Qwen 3B support route 比 always-Claude 少 38.7% comparison cost；holdout 上 3/16 vs 2/16 tasks 且 comparison cost 低 1.26%。但 README 明确说 baseline 无效、这不构成 savings 或可靠性证明，生产泛化未知。
- 上下文/记忆怎么在多个 agent 间传递：repo-local state 跨会话：`.planning/` 存 campaigns/runs/evidence/handoffs/telemetry，`.citadel/scripts/` 放项目本地协调脚本，`.claude/agent-context/` 放给 delegated agents 的 rules，`.claude/harness.json` 是 setup 生成的项目配置；`Resume` 状态为全新 session 指明"下一步有用动作"，handoffs 也在其中。
- 值得我们借鉴的 1–3 个具体做法：1）五状态操作循环 Request→Run→Evidence→Needs You→Resume，尤其是 Resume 必须写出"下一步有用动作"，可直接补进我们的中断恢复；2）Evidence 四态且 missing≠success 的 fail-honest 验收，能让我们的独立检查更严格；3）把操作状态从应用代码分离到 `.planning/` 与 `.claude/agent-context/`，以及 release 的 checksum/manifest/provenance + 用 plan token 做 receipt-owned uninstall，都是可搬的工程习惯。
- 我们已经有、或不适合我们的：我们已有独立检查与按风险分级验收；Citadel 是经插件市场安装、含 48 skills/36 hooks 的完整 harness，体量远超所需且绑定 Claude Code/Codex，但其 evidence 四态与 Resume 约定可直接抄。

## stellarlinkco_myclaude（myclaude）
- 一句话定位：Claude Code 多 agent 工作流系统，支持多后端执行（Codex/Claude/Gemini/OpenCode）。
- 怎么分派任务：Orchestrator 是 Claude Code（负责 planning、context gathering、verification），Executor 是 `codeagent-wrapper`（负责 code editing 与 test execution，后端可选 Codex/Claude/Gemini/OpenCode）；`omo` 模块主打 "intelligent routing" 的多 agent 编排，`do` 模块是 5 阶段特性开发；另有按场景选工作流的决策表（特性开发→`/do`、bug 调查修复→`/omo`、大型企业项目→`/bmad-pilot`、快速原型→`/requirements-pilot`、简单任务→`/code` `/debug`）。
- 质量把关：`essentials` 提供 review 命令，`sparv` 流程含 Review 与 Vault 阶段，`product-requirements` 有 quality scoring，`skill-install` 安装 GitHub skill 时做 security scanning，`--update` 从 GitHub 最新 release 覆盖更新。自动测试与回退细节未提及。
- 成本/额度控制：未提及（只有多后端选择，无 token 统计或成本路由规则）。
- 上下文/记忆怎么在多个 agent 间传递：未提及（只描述安装后的 `~/.claude` 目录结构、默认安装 `CLAUDE.md`，无跨 agent 记忆机制）。
- 值得我们借鉴的 1–3 个具体做法：1）用一个 `codeagent-wrapper` 把 Codex/Claude/Gemini/OpenCode 统一成同一 executor 接口，编排方不必关心后端差异，正合我们多厂商栈；2）"按场景选工作流"的决策表，可让我们按 bug/新特性/原型选择不同的派工与验收模板；3）`config.json` 按模块 enable/disable 控制加载，与我们按需加载、省 token 的思路一致。
- 我们已经有、或不适合我们的：我们已直接组合不同厂商 CLI，且它是 AGPL-3.0、强绑定 Claude Code 的 `~/.claude` 插件目录，不适合嵌入。

## TheColliery_CoalTipple（CoalTipple）
- 一句话定位：Claude Code 的 model/effort 路由器——把"自己能做但量大又便宜"的任务 delegate-DOWN 到便宜档省 token，把超出能力的 escalate-UP 到更强档保质量。
- 怎么分派任务：路由逻辑写在 `SKILL.md` 里由模型在自身 context 内本地决定（无后台 daemon）；按 prompt 文本 grade 出起始 tier（从最便宜开始），敏感任务（cryptography/auth/payments/security 等关键词）强制 `heavy`；任务小于 `delegateMinLines`（默认 120）留在 main 避免 spawn 开销；用户可见写作/翻译留在 main；`grade-task.mjs` 会打印 JSON 形式的 grade/tier/sensitive/reasons。它把路由拆成两个独立旋钮：TIER（正确性，`low<mid<heavy<reasoning`）与 EFFORT（规模，`low→max`），并规定"先加 effort 再加 tier"。
- 质量把关：`qualityBar` 阶梯（0–100，默认 60）——任务 grade 先选最便宜起始 tier，跑完按 task contract 验证，通过即结束、失败就往上爬一格，尝试/失败用尽直接跳顶档；合并要求客观检查通过（`qaOnMerge`: strict/standard/off）；用 git worktree 隔离或 `.claude/.coaltipple/proposed/` sandbox + `state.json` journaling 防中途失败损坏文件；遇 rate limit 自动落到下一档但绝不低于敏感任务的最低 tier；worker 是叶子，不许再 spawn；有副作用的命令（bash 变更、commit）永不委托。
- 成本/额度控制：有近似统计与硬闸门：`/coaltipple stats` 显示 approximate token savings 与 delegate-down/escalate-up 活动；最高档 `fable` 是真实花钱 spawn，默认 `fableConsent: false`，升级到该档前先征得同意；benchmark 称从 Opus main 出发 routing ON 约便宜 23%。它明确不做跨厂商、宣称"机制可查"而非"节省数字最优"。
- 上下文/记忆怎么在多个 agent 间传递：worker 默认 context-fresh，靠一份 **memory anchor** 文件给新 worker 项目上下文；`contextFiles` 为空时自动加载 `CLAUDE.md`/`AGENTS.md`，可用 `/coaltipple memory` 管理；config 分层（全局 + first-found-wins 项目覆盖，项目可 `enableRouting: false` 关掉）。
- 值得我们借鉴的 1–3 个具体做法：1）qualityBar 质量阶梯——从最便宜档起跑、验证失败逐级爬升、用尽跳顶档，可把我们现在"按预估轮数一次性选模型"改成"按结果逐级升级"，更省也更稳；2）三条硬规则：敏感任务强制最低档且永不下沉、低于规模阈值不委托、有副作用的命令不委托，正好补进我们的风险分级与写入范围锁，形成"永不外包清单"；3）The Lock 的 fail-safe 设计（只可能"路由正确"或"路由关闭"，ranking 坏了就关路由，spawn 失败自动落到下一档）以及 worker 是叶子、禁用递归 spawn。
- 我们已经有、或不适合我们的：我们已有风险分级验收和 Jev 类分类判断；CoalTipple 明确只支持 Claude Code（需要 agent 能选 spawned worker 的 model+effort，连 Antigravity 都因跨厂商/无 effort 旋钮而不适配），我们的多厂商栈无法直接安装，但质量阶梯与三条硬规则可移植。

## 横向结论

按对我们价值从高到低：

1. **质量阶梯（qualityBar staircase）：从最便宜档起跑，按 task contract 验证，失败爬一格，用尽跳顶档。** 来自 TheColliery_CoalTipple。这是对我们现有"按预估轮数一次性派工"最直接的升级——把静态判断换成基于实际结果的逐级升级，既省 token 又保质量。
2. **Evidence 四态 + missing≠success + Resume 明确下一步。** 来自 SethGammon_Citadel。给我们的独立检查和按风险分级验收补上"证据不足不算通过"的硬规则，并让每个中断点都留下一个可执行的下一步。
3. **本地可解释的路由判断：`explain` 打印决策边界、离阈值多近、什么会翻转它。** 来自 jig21nesh_model-switcher。我们的 Jev 分类判断目前是黑盒，这套解释输出能让"为什么这么分、分得险不险"可审计、可调阈值。
4. **成本记账的诚实取向：cache TTL 分开计价、不确定标 `n/a`、单模型不虚报节省、节省是注明分母的反事实。** 来自 jig21nesh_model-switcher。可直接补强我们的 token 账本，避免账本自欺。
5. **三条硬规则：敏感任务强制最低档且永不下沉、低于规模阈值不委托、有副作用的命令不委托。** 来自 TheColliery_CoalTipple。作为我们的"永不外包清单"，与写入范围锁、风险分级验收天然互补。
6. **从自己的历史校准阈值：先出候选与 before/after，必须显式 apply，并暴露"学到的是难度还是项目主题"。** 来自 jig21nesh_model-switcher。可用来把"预估轮数"的门槛从拍脑袋变成用我们自己的 transcript 校准。
7. **每个任务一个 worktree/branch 隔离，并把 CI/检查失败与 review 意见回送给同一个 owner agent。** 来自 OrchestratorInc_agent-orchestrator。在写入范围锁之外再加 git 级防碰撞，并补齐我们检查后的反馈闭环。
8. **给每个子 agent 注入 codebase map，并用结构化 `jobs --json`（tokens/files_modified/summary）取回结果。** 来自 kingbootoshi_codex-orchestrator。减少执行者现场探索的 token，让编排方能机器化验收而不是抓屏。
