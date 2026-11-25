# dsh-plugin-repeat-tool-guard

**无人值守空转硬止损**：当归宿没人盯着时，DeepSeek Harness 的 agent 仍可能对同一类网页抓取反复调用，只是每次换一个查询串、后缀或文件编号。这个插件在运行时把它按“目标”归一化、限制重复次数，并用单轮/每小时的硬预算直接结束整轮。

它不是“提醒模型注意”，而是**不依赖模型自觉**的刹车。

## 它解决的具体事故

2026-11-25，一个真实 DSH 会话里：

- 同一个 `chart_stats` URL 被 `web_fetch` 抓了 **229 次**；
- 4 轮共 **488 次** `web_fetch`，其中大量是 `maidle.py`、`record_filter.py` 这类只换后缀的 404 猜测；
- 用户连续发了 5 条“你在干什么 / 停止”，循环仍在继续；
- 大结果每次被 spill 到 `/tmp/...`，随机路径不同，按“结果指纹”判重的护栏会误以为每次都有新进展。

两个根因：

1. **官方 `repeat-tool-reminder` 只提醒，不阻止**，且任何用户消息都会把计数清零；
2. **没有单轮时间/步数上限**，agent loop 本身可以跑到几百步。

## 防护规则

### 1. 按目标去重，而不是按参数字符串

`web_fetch` 的 URL 会先归一化：

- 去掉 query string 和 fragment；
- 路径最后一段去掉 `.md5`、`.sig`、`.asc`、`.txt`、`.json` 等噪声扩展名；
- 主机名统一小写。

所以这些都会被算作同一个目标：

```
https://example.com/a/audit.ts?x=1
https://example.com/a/audit.ts.md5
https://example.com/a/audit.ts.md5.txt
https://example.com/a/audit.ts.sig
```

### 2. 失败记忆

结果里出现 4xx/5xx 或 `404`，就记这个目标失败。**同一目标失败 2 次后，它的任何后缀/查询串变体都直接拒绝**——重试一个 404 不会变成 200。

### 3. 单目标预算

同一目标每轮最多抓 `perTarget` 次（默认 4），超过就拒绝。

### 4. 无人值守硬预算（关键）

以下任一超限，直接 `agent.cancel()` **结束整轮**，不是只拒绝这一次调用：

| 预算 | 默认值 | 说明 |
|---|---:|---|
| 单轮工具调用数 | 60 | 所有工具都算，防止换工具继续跑 |
| 单轮 `web_fetch` 数 | 30 | 防止换目标继续抓 |
| 单轮墙钟时间 | 15 分钟 | 模型思考慢、命令卡住也算 |
| 每小时 `web_fetch` 数 | 120 | 跨轮保留，防止 goal/定时任务每轮重置预算 |

这些预算**不会被用户消息清零**。你发“停止”只会清掉重复记忆，不会给模型一次新的 60 次额度；只有进入新的一轮才重置单轮预算，每小时窗口跨轮保留。

### 5. 按 agent 隔离

子代理有自己的预算，不会共享主 agent 的计数。

## 安装

从 npm：

```sh
dsh plugin --profile web add dsh-plugin-repeat-tool-guard
```

从 GitHub：

```sh
dsh plugin --profile web add github:EricScottLin/dsh-plugin-repeat-tool-guard
```

安装后重启 `dsh web`（或让 profile 热重载）生效。插件不带 UI、不注册新工具，只在后台 hook 上工作。

## 配置

在 `cordis.patch.yml` 或 profile 的 bundle 配置里覆盖：

```yaml
- id: repeat-tool-guard
  config:
    perTarget: 4
    maxFailures: 2
    maxToolCallsPerTurn: 60
    maxFetchesPerTurn: 30
    maxTurnMinutes: 15
    maxFetchesPerHour: 120
```

| 键 | 默认 | 含义 |
|---|---:|---|
| `perTarget` | 4 | 同一目标每轮最多抓取次数 |
| `maxFailures` | 2 | 同一目标失败多少次后拒绝所有变体 |
| `maxToolCallsPerTurn` | 60 | 单轮所有工具调用上限 |
| `maxFetchesPerTurn` | 30 | 单轮 `web_fetch` 上限 |
| `maxTurnMinutes` | 15 | 单轮墙钟上限（分钟，可用小数） |
| `maxFetchesPerHour` | 120 | 每 agent 每小时 `web_fetch` 上限 |

## 验证

```sh
npm test
```

测试覆盖 10 项：目标归一化、404 失败记忆、单目标预算、工具预算、抓取预算、墙钟预算、每小时预算、用户消息不清零、新轮重置、不同 agent 隔离。

仓库里另有 `docs/VERIFY.md`，记录了 2026-11-25 的实机验证：同一个 `chart_stats` 连续 4 次，第 3、4 次被兜底 guard 拒绝，没有发出网络请求。

## 它不做什么

- 不阻止**单条 `bash` 命令内部**自己循环 `curl`；这种只能靠 15 分钟墙钟和 bash 工具本身的超时。
- 不限制子代理数量；每个子代理有自己的预算。
- 不设绝对金额/token 上限；每小时 120 次是频率限制，不是账单上限。
- 不做“语义相似”判断；只做 URL 归一化 + 预算。换域名、换完全不同的路径不会被误判为同一目标。

## 和现有插件的关系

- `@deepseek-ai/dsh-repeat-tool-reminder`：官方，**只提醒**，用户消息清零。
- `@goodandready/dsh-agent-loop-guard`：功能更全，但按“结果有没有进展”判断，遇到 spill 随机路径会误判为有进展。
- `dsh-loop-breaker` / `dsh-repeat-stop`：按完全相同的参数计数，换后缀/查询串会当成新调用；且用户消息会清零。
- 本插件：补“目标归一化 + 无人值守预算 + 用户消息不清零”这一层。可以和上面任意一个共存。

## 许可

MIT
