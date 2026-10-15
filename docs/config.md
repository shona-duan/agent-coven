# 本机配置

配置文件放在 agent-hub 根目录的 `config.json`，由脚本位置定位，不依赖当前工作目录。该文件已被 Git 忽略；`config.example.json` 是可提交的示例。JSON 不支持注释，示例中 `_` 开头的说明键在读取时忽略。

| 字段 | 含义 | 未配置时的默认值 | 环境变量 |
|---|---|---|---|
| `codex_bin` | codex 可执行文件 | 从 `PATH` 查找 `codex` | `AGENT_HUB_CODEX_BIN` |
| `node_bin` | 派工记账使用的 node 可执行文件 | 从 `PATH` 查找 `node`，找不到再用 codex 同目录的 `node` | `AGENT_HUB_NODE_BIN` |
| `proxy` | Jev 等外网调用代理；空字符串表示不用代理 | `""` | `AGENT_HUB_PROXY` |
| `dsh_homes` | DeepSeek dsh 数据目录，供账本读取用量 | `[]` | 无 |
| `repo_roots` | 账本识别仓库的父目录，`<root>/<目录名>` 记为仓库 | `["~/Desktop", "~/code", "~/projects", "~/src"]` | 无 |

读取顺序为环境变量 > `config.json` > 默认值。配置文件不存在时使用默认值；codex/node 的空字符串同样使用默认查找规则，路径支持 `~/`。

Jev 的代理顺序为 `HTTPS_PROXY` > `https_proxy` > `AGENT_HUB_PROXY` > `config.json` 的 `proxy` > 不设代理。前两个变量以非空值为准；显式设置 `AGENT_HUB_PROXY=""` 可关闭配置文件中的代理。Jev 保持自动启用 `NODE_USE_ENV_PROXY=1` 的逻辑。

`dsh_homes`、`repo_roots` 支持 `~/`、`$HOME/` 和绝对路径。账本也合并旧 `ledger/prices.json` 中的 `dsh_homes`，相同目录去重；新配置应写入 `config.json`。仓库名限定为 `[\w.-]+`，父目录下的普通文件不算仓库；`~/agent-hub` 始终单独识别。

新机器先确保 Python 3、node、codex 已可用，然后复制示例并按需修改：

```sh
cd ~/agent-hub
cp config.example.json config.json
```

codex/node 已在 `PATH` 中时可保留空值；代理按本机实际地址填写，不需要则留空。使用 DeepSeek dsh 时把数据目录填入 `dsh_homes`，例如 `["~/dsh-trial/.dsh"]`；将代码所在的父目录填入 `repo_roots`。无需本机定制也可不创建配置文件。

此配置与 `state/team-dev/config.json` 独立，后者仍由 team-dev 管理。外部 `~/dsh-trial/run_task.py` 不读取本配置。
