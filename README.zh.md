# dsh-plugin-repeat-tool-guard

## 概要

**当没人盯着屏幕时，DSH 的 agent 可能对同一个网页连续抓几百次，每次都只换一个查询串、文件后缀或编号。** 这个插件在运行时按“网页目标”归一化去重，并加上单轮/每小时的硬预算；一旦超限，直接 `agent.cancel()` 结束整轮，不再等模型自己停下来。

- 适用：DeepSeek Harness 0.2.x（实测 `0.2.2-rc.5`）。
- 解决：`web_fetch` 同源变体反复抓取、404 后缀猜测、无人值守长循环。
- 措施性质：**host 侧运行时兜底**，不是提示词，不依赖模型自觉，也不修改 DSH 核心。
- 零运行时依赖，不带 UI，不注册新工具。

安装（当前从 GitHub）：

```sh
dsh plugin --profile web add github:EricScottLin/dsh-plugin-repeat-tool-guard
```

## 问题背景

2026-11-25，我在一个真实 DSH 会话里遇到一次很严重的空转：

- 模型：`deepseek-v4-1-flash-1017`
- 供应商：`mistral`
- 推理档位：`low`
- DSH 版本：`0.2.2-rc.5`
- 结果：4 轮、545 次工具调用，其中 **488 次是 `web_fetch`**；单是 `chart_stats` 一个 URL 就被抓了 **229 次**。

抓取的 URL 大致是这样变化的：

```
https://www.diving-fish.com/api/maimaidxprober/chart_stats
https://www.diving-fish.com/api/maimaidxprober/chart_stats?t=1
https://raw.githubusercontent.com/.../maimai_analysis_curve.py
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.md5
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.md5.txt
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.sig
```

看起来每次参数都不同，实际上都是同一个目标；有些是 404 后不断猜后缀，有些是大结果反复抓。更糟的是，用户连续发了 5 条“你在干什么 / 停止”，循环仍然继续。

这个问题的危险点不是“模型偶尔多抓一次”，而是**无人值守**：goal、定时任务，或者用户只是走开了。人盯着还能按停止；没人盯着，就会一直烧 token，直到手动中止。

## 解决过程

我先试了现成方案，也读了同类插件的源码。

### 1. 官方 `repeat-tool-reminder`

DSH 自带，默认在连续 3/5/8 次相同调用时提醒。问题是：

- 它**只提醒，不阻止**，模型可以完全无视；
- 任何用户消息都会**把计数清零**，所以“你越催，它越能重新开始”。

它按设计只在 3/5/8 次提醒；这次并没有阻止循环。

### 2. `@goodandready/dsh-agent-loop-guard` 0.3.6

这是社区里功能最全的一个，我实际装了并做了对照测试：

- `example.com` 连续抓 4 次：第 3、4 次被 `[LOOP_GUARD_STEER]` 拦下，正常；
- `chart_stats` 连续抓 4 次：**4 次全部放行，一次都没拦**。

原因是它按“结果有没有产生新证据”判断进展。而大结果每次都被 spill 到 `/tmp/...`，随机路径不同，结果指纹就不同；它误以为每次都有新进展。

### 3. `dsh-loop-breaker` / `dsh-repeat-stop` / `dsh-brake`

我读了这几个的源码，没有继续安装：

- `dsh-loop-breaker`：按“工具 + 参数”精确计数，带 25 步/5 分钟单轮预算，设计很接近；但**不做 URL 归一化**，换后缀/查询串就当成新调用，而且用户消息会重置计数。
- `dsh-repeat-stop`：同样是精确参数计数，默认 6 次后硬拦；**没有单轮/每小时预算**，用户消息也会清零。
- `dsh-brake`：偏实验，描述里没有完整的预算/取消语义，未采用。

它们各自解决了“完全相同的参数”这一种情况，但这次事故的形状是“参数看起来不同、目标相同”，再加上“无人值守”。

前后一共对照了三组：官方提醒、`@goodandready/dsh-agent-loop-guard`、以及精确参数类插件（`dsh-loop-breaker` / `dsh-repeat-stop` / `dsh-brake`），没有一组覆盖这次事故的形状。

### 结论

需要一个同时满足四点的兜底：

1. 不按参数字符串，而按**归一化后的目标**计数；
2. 不因用户消息**重置预算**；
3. 有**绝对的单轮/每小时上限**，不依赖“结果有没有变化”；
4. 超限直接**结束本轮**，不是只拒绝一次调用。

## 解决方案

插件分两层：判定层 + 兜底层。

### 判定层：按目标去重

`web_fetch` 的 URL 先归一化：

- 去掉 query string 和 fragment；
- 主机名统一小写；
- 路径最后一段去掉 `.md5`、`.sig`、`.asc`、`.txt`、`.json` 等噪声扩展名。

所以 `audit.ts?x=1`、`audit.ts.md5`、`audit.ts.md5.txt`、`audit.ts.sig` 都会落到 `audit.ts` 这个目标。

在此基础上：

- **失败记忆**：结果里出现 4xx/5xx 或 `404`，就记这个目标失败；同一目标失败 2 次后，所有后缀/查询串变体都拒绝。
- **单目标上限**：同一目标每轮最多 `perTarget` 次（默认 4），超过就拒绝。
- **连续重复**：同一目标连续出现 3 次（带一点容忍）也拒绝。

### 兜底层：无人值守硬预算

以下任一超限，直接 `agent.cancel()` 结束整轮：

| 预算 | 默认值 | 说明 |
|---|---:|---|
| 单轮工具调用数 | 60 | 所有工具都算，防止换工具继续跑 |
| 单轮 `web_fetch` 数 | 30 | 防止换目标继续抓 |
| 单轮墙钟时间 | 15 分钟 | 模型思考慢、命令卡住也算 |
| 每小时 `web_fetch` 数 | 120 | 跨轮保留，防止 goal/定时任务每轮重置 |

关键点是：**这些预算不会被用户消息清零**。你发“停止”只会清掉重复/失败记忆，不会给模型一次新的 60 次额度；只有进入新的一轮才重置单轮预算，每小时窗口跨轮保留。

### 这是什么性质的措施

它是**运行时兜底**，不是模型修复，也不是提示词：

- 在 host 侧挂 `tools/pre-execute`、`tools/post-execute`、`agent/pre-step`；
- 用确定性的计数器、URL 归一化、时间窗口做判断；
- 超限调用 `agent.cancel({ kind: 'hook', reason })`；
- 不依赖模型“理解”规则，也不依赖用户盯着。

它假设模型可能不配合，所以把“停下来”做成机械条件。

## 测试结果

### 单元测试

```sh
npm test
```

**10/10 通过**，覆盖：

1. 目标归一化（query/fragment/大小写/噪声后缀）；
2. 4xx/5xx 识别；
3. 配置默认值与非法值；
4. 单目标上限；
5. 两次 404 后拒绝所有后缀变体；
6. 单轮工具预算 + 用户消息不清零 + 新轮重置；
7. 单轮抓取预算（不同目标）；
8. 每小时预算跨轮保留；
9. 墙钟预算取消本轮；
10. 不同 agent 预算隔离。

### 实机测试

对同一个 `chart_stats` URL 连续抓 4 次：

- 第 1、2 次：正常返回；
- 第 3、4 次：被 `repeat-tool-guard` 拒绝，**没有发出网络请求**。

这正是之前会产生 229 次调用的场景，现在能及时中断。

### 安装路径

- GitHub 源码安装：在临时项目里 `pnpm add github:EricScottLin/dsh-plugin-repeat-tool-guard`，安装 1.0.0 并 `import` 成功。
- npm 打包：`npm publish --dry-run` 通过（8 个文件、约 11 kB）。

## 通用性

这个插件不是只给 `chart_stats` 写的：

- 目标归一化适用于任何 `web_fetch` URL；
- 预算对所有工具生效，不只 `web_fetch`；
- 每个 agent 独立计数，子代理有自己的预算；
- 所有阈值都可配置，不假设某个 API、某个域名或某个模型；
- 作为标准 DSH bundle 安装，不修改 DSH 核心。

已知边界：

- 单条 `bash` 命令内部自己循环 `curl` 时，插件只看到“一次 bash 调用”；只能靠 15 分钟墙钟和 bash 工具本身的超时。
- 不限制子代理数量；每个子代理有独立预算。
- 每小时 120 次是频率限制，不是金额/token 上限。
- 不做语义相似；只做 URL 归一化 + 预算。换域名、换完全不同的路径会被当成不同目标。

## 配置

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

## 和现有插件的关系

- `@deepseek-ai/dsh-repeat-tool-reminder`：官方，**只提醒**，用户消息清零。
- `@goodandready/dsh-agent-loop-guard`：功能更全，但按结果指纹判断，spill 随机路径会误判为有进展。
- `dsh-loop-breaker` / `dsh-repeat-stop`：按完全相同的参数计数，换后缀/查询串会当成新调用；且用户消息会清零。
- 本插件：补“目标归一化 + 无人值守预算 + 用户消息不清零”这一层。可以和上面任意一个共存。

## 许可

MIT
