# 固定测试集（evals）

调规则、阈值、提示词前后，用同一套测试集整套重跑对比，而不是临时找一两个例子试（Anthropic 的做法：约 20 个真实样本起步）。

目前有一个套件：`jev-screen`，测 Jev 初筛的抓到率和误报率。**本仓库不附带测试数据**（作者的数据来自公司仓库），请从自己的真实派活里攒：

```sh
# 把一次真实派活（codex_task.py 运行目录，含 changes.patch、brief.txt）加进测试集，标注期望的报警
python3 evals/add_case.py --run ~/agent-hub/runs/codex-<时间戳> --expect none --suite jev-screen
python3 evals/add_case.py --run ~/agent-hub/runs/codex-<时间戳> --expect incomplete,out_of_brief --suite jev-screen

python3 evals/run_jev_screen.py --save-baseline   # 保存基线（会调用 Jev）
python3 evals/run_jev_screen.py                   # 之后每次改动：重跑并与基线对比，列出判断翻转的条目
python3 evals/run_jev_screen.py --from-file 分数.json   # 离线评分，不调用 Jev
```

数据格式：`evals/jev-screen/cases.json`（每条 id / brief / patch / expect / source，可选 expect_hint）+ `patches/*.patch`。

指标：
- **抓到率**：expect 里列出的 flag，分数 ≥ 阈值（默认 0.5，`--threshold` 可改）即算抓到。
- **误报率**：source=真实提交且 expect 为空的条目，分数 ≥ 阈值即误报；expect_hint 里列出的 flag 不算误报。

作者实测（43 例：25 个真实提交 + 18 个注入问题）：没做完 6/6 抓到、0/25 误报；混进无关改动 6/6、2/25；删了原有功能 4~5/6、2/25。
同一数据连跑有噪声（0.5 附近会翻转），单项差一两条不算数。
