# 草稿：给 DSH 社区的空转警告帖（中文）

状态：草稿，未发布。建议发在 DeepSeek Harness GitHub Discussions 的
「Show and tell」分类；相关上游讨论：
https://github.com/deepseek-ai/deepseek-harness/discussions/5976

---

## 标题

无人值守时，DSH agent 可能对着同一个网页抓几百次——这是它的形状，以及一个护栏

## 正文

我想提醒一个真实发生过、而且很容易被忽略的失败模式。

在一次 DSH 会话里：

- 同一个 `chart_stats` URL 被 `web_fetch` 抓了 **229 次**；
- 4 轮共 **488 次** 抓取，很多是 `maidle.py`、`record_filter.py` 这种只换后缀的 404 猜测；
- 用户连续发了 5 条“你在干什么 / 停止”，循环还在继续；
- 每次大结果都被 spill 到 `/tmp/...`，随机路径不同，所以按“结果指纹”判重的护栏会以为每次都有新进展。

这不是单纯的“模型笨”，而是三层叠加：

1. **官方 `repeat-tool-reminder` 只提醒、不阻止**，而且用户一发消息就清零；
2. **agent loop 没有单轮步数/时长上限**，`maxParallelToolCalls` 不是步数预算；
3. **大结果让“结果去重”失效**，spill 路径和压缩 stub 每次都不一样。

最危险的是**无人值守**：goal、定时任务，或者用户只是走开了。人盯着还能按停止；没人盯着，循环会一直烧 token。

### 我做了什么

写了一个很小的 host 插件 `dsh-plugin-repeat-tool-guard`，思路是“预算”，不是“再提醒一次”：

- 按 URL 目标归一化（去掉 query/fragment，去掉 `.md5/.sig/...` 后缀），同一目标限制次数；
- 记住 404：同一目标失败两次后，所有后缀变体都拒绝；
- **硬预算**：单轮 60 次工具调用 / 30 次 `web_fetch` / 15 分钟，超限直接 `agent.cancel()` 结束整轮；每小时最多 120 次抓取；
- 用户消息**不会**重置这些预算——说“停止”不该给循环一次新的额度。

MIT、零运行时依赖，单元测试和实机复现在仓库里：
https://github.com/EricScottLin/dsh-plugin-repeat-tool-guard

它是补充，不是替代：`@goodandready/dsh-agent-loop-guard` 覆盖更多形状（流式重复、报错空转），`dsh-loop-breaker` / `dsh-repeat-stop` 覆盖完全相同的参数重复。用哪个都行，关键是**至少有一个不依赖模型自觉的硬预算**。

### 想请大家一起做的事

如果你在写 agent 插件，除了“提醒模型”，请考虑暴露一个硬性的单轮工具/时间预算。提醒是给配合的模型用的；预算是给凌晨三点没人看着的情况用的。
