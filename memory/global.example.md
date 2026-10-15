# 共享记忆（Claude 与 Codex 共用这一份）

Claude 通过 ~/.claude/CLAUDE.md 引用本文件（`@~/agent-hub/memory/global.md`），Codex 通过 ~/.codex/AGENTS.md（软链）读取本文件。
详细内容放在同目录 global/、projects/ 下；需要细节时再打开，不必每次全读。

## 记忆怎么用、怎么写
- 通用记忆规则（谁能写、事实 vs 易变状态、矛盾以代码为准）见下方引用的 rules/collaboration.md。
- 跨项目通用 → global/；只与某仓库有关 → projects/<仓库目录名>/README.md。
- 在某个仓库里工作时，先读 projects/<仓库目录名>/README.md（存在的话）。

## 全局规则
- （在这里写你自己的红线，例如分支规范、联网代理等）

## 多模型协作
**Codex 注意：下面两行 @ 是文件路径，开工前先读这两个文件（Claude 会自动加载）。**
- 通用协作规则、本人偏好：

@~/agent-hub/rules/collaboration.md

@~/agent-hub/memory/profile.md

- 正式派活/验收全流程用 skill `team-dev`（Claude /team-dev、Codex $team-dev 显式调用）。
