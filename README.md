# DeepSeek 鲸鱼费用挂件

DSH Web GUI 的 DeepSeek 鲸鱼组件。悬浮球显示**本会话累计费用**；点击面板显示：

- 充值余额
- 本会话消费金额
- 本轮消费金额
- 当前工作区累计消费金额

费用使用 DeepSeek 官方人民币价目；价目和节假日都会异步刷新。悬浮球不显示 token 数量，面板底部没有免责小字。

## 安装

仓库地址：[Rajki22/dsh_plugin](https://github.com/Rajki22/dsh_plugin)

本仓库是 DSH Web 的本地插件源码。将仓库克隆到本地后，在 DSH 的插件管理/设置中作为本地插件包安装；包内已包含 `dsh.bundle.patch`，不需要构建步骤。

```bash
git clone https://github.com/Rajki22/dsh_plugin.git
```

本插件的费用来自当前 Session 已记录的 usage，不调用模型，不会产生额外的 LLM token 消耗。

## 官方价目与动态刷新

官方来源：[DeepSeek API 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

内置保底：[pricing/deepseek.json](pricing/deepseek.json)

| 模型 | 时段 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | ---: | ---: | ---: |
| deepseek-flash | 高峰 | 0.04 | 2 | 8 |
| deepseek-flash | 空闲 | 0.02 | 1 | 4 |
| deepseek-v4-pro | 高峰 | 0.30 | 9 | 27 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

单位：元 / 百万 tokens。`deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 按 Flash 价目计费。

### 抓取与缓存

- Host 启动时先异步读取本地缓存
  `$DSH_PROFILE_DIR`（若设置）或 `$DSH_HOME` 下的
  `cache/dsh-whale-widget/pricing.json`；
- 缓存文件修改时间在 24 小时内则直接使用，不请求网络；
- 超过 24 小时且当天尚未尝试过，才后台请求官方页面；
- 每天最多一次网络尝试；失败也不会在同一天反复请求；
- Host 每 24 小时触发一次 `pricing.refresh` / `holiday.refresh`，启动时也各触发一次；同一时刻只有一个在途请求；
- 定时器通过 `ctx.effect(() => ctx.timer.interval(...))` 注册，Host 卸载时自动清理；
- 解析成功才覆盖缓存并更新 live 引擎；
- 解析失败、超时、官网改版时静默保留旧缓存；没有缓存则使用内置 `pricing/deepseek.json`。

抓取完全在后台进行，不阻塞 Host 启动。已折叠的 live 历史费用不会被追改；后续 usage 和下次 cold 重算使用新价目。

### 价目源状态

`GET /dsh-whale-widget/pricing-info` 返回：

- `pricingSource`：`official-page` / `official-cache` / `bundled-cny`
- `cacheFile`、`cacheUpdatedAt`
- `lastAttemptDate`、`lastSuccessAt`、`lastFailureAt`
- `lastError`：成功加载的缓存比最后一次失败新时，旧错误会被清空

降级判断：

- `pricingSource=bundled-cny` 且 `lastError != null`：连缓存都没有，正在用内置表；
- `pricingSource=official-cache` 且 `lastError != null`：抓取失败，继续用上次成功缓存；
- `pricingSource=official-page`：本次 live 更新成功。

Host 日志也会输出：

```text
[dsh-whale-widget] pricing updated source=official-page models=2 cache=...
[dsh-whale-widget] pricing fetch failed; keeping official-cache|bundled-cny: ...
```

## 峰谷与法定节假日

节假日来源：[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)

```text
https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json
```

### 判断规则

全部按北京时间（UTC+8）匹配日期：

- `isOffDay: true`：法定节假日，全天按空闲价；
- `isOffDay: false`：调休补班日，按工作日的高峰/空闲时段判断；
- 不在列表中的周末：全天空闲；
- 不在列表中的工作日：09:00–12:00、14:00–18:00 为高峰；
- 高峰区间左闭右开；
- 无法解析的 `event.time` 不参与时段判断：该条费用按 0 计，`invalidTimeCount` 加一，不静默落入空闲价。

### 缓存与抓取时机

- 内置 2024、2025、2026 三年数据：[holidays/](holidays/)。
- Host 启动先读内置文件和
  `$DSH_PROFILE_DIR`（若设置）或 `$DSH_HOME` 下的
  `cache/dsh-whale-widget/holidays/{year}.json`；
- 当前年份没有网络缓存时，后台尝试抓取当前年；
- 当前月份 >= 11 且次年没有缓存时，后台尝试抓取次年；
- 每天最多一次检查；`holiday-meta.json` 记录 `lastCheckDate`，失败也不在同一天重试；
- 404（次年未发布）或网络失败时，保留旧缓存/内置保底，不抛错、不阻塞启动。

### 节假日源状态

`GET /dsh-whale-widget/holiday-info` 返回每年的来源（`builtin` / `cache` / `network`）、天数、缓存文件和最近错误。

Host 日志：

```text
[dsh-whale-widget] holidays loaded days=108 years=2024:builtin,2025:builtin,2026:builtin
[dsh-whale-widget] holidays updated year=2026 days=... cache=...
[dsh-whale-widget] holiday fetch failed year=2027: ...
```

本机从 GitHub raw 抓取失败时会静默使用内置 2024–2026 数据；节假日判断仍然正确。

## 本轮消费金额

`whaleCost` projection 的 wire view 现在是：

```json
{
  "totalCny": 10.99,
  "currentTurnCny": 0.40,
  "turnSeq": 5276,
  "invalidTimeCount": 0
}
```

- **Turn 开始**：投影遇到 `user/message` 时，把当时的 `totalCostCny` 记为 `turnBaseCny`，把该事件 seq 记为 `turnSeq`；
- **Turn 累计**：`currentTurnCny = max(0, totalCny - turnBaseCny)`；
- 工具调用、多次 assistant 消息、attempt/retry 的 usage 都继续累加到同一个 total，因此都在同一个 turn 内；
- 下一条 `user/message` 覆盖基准线，`currentTurnCny` 归零后重新累计；
- 切换会话时读取该会话自己的投影状态；没有基准则本轮为 `0`。

### 闪烁时机

Client 通过 `useSessionStatus` 读取该会话的 `running`：

- 只在 `running: true -> false`（整轮结束/停止）后先等待 **600ms** 稳定，再读最新 `currentTurnCny`；工具步骤间短暂 idle 不会误闪；
- AI 生成中的多次 usage 不会触发闪烁；
- 悬浮球显示 `+¥xx`，2.6 秒后恢复本会话累计；
- 新 `turnSeq` 会清除上一轮残留的闪烁。

### 中断与工具调用

- 用户 Stop 导致 `running` 变 false；本轮金额 = 停止时 total - 本轮基准，已记录/已计费的 usage 都保留；
- 一轮内多次工具调用、多条 assistant 消息不会重置基准，全部计入同一 `currentTurnCny`；
- 只有新的 `user/message` 才会重置。

调试时可看：

```js
const root = document.querySelector('.dsw-whale-root')
root.dataset.running   // "true" while the turn is running
root.dataset.turnSeq   // current user/message seq
```

## 当前工作区累计范围

`workspace.sessionIds` 的准确含义：

- 以 **canonical cwd** 归属当前工作区的所有 Session header；
- 包含主会话、子智能体（subagent）、衍生/分支会话（fork）；
- 包含已归档（archived）会话；归档只影响显示，不移除 workspace 的 `sessionIds` 槽位；
- 不包含 cwd 指向其他目录的会话（例如另一个 worktree 的独立工作区）。

因此不是只遍历“主视图活跃会话”。

### fork 不重复计费

fork 的日志会包含从父会话继承的事件前缀。`whaleCost` 使用 `inheritedEventCount` 作为 `startSeq`，跳过继承前缀，只累计本会话新增 usage；否则父会话 + fork 会把同一段历史算两次。

工作区路由返回 `scope` 字段，说明当前遍历口径；`workspaceId` 用于确认命中的工作区。`processedSessions` 是成功读取 total 的会话数，`failedSessions` 是读取失败数；工作区路径不会读取 tokenUsage/model。

### 与官方总消费对账

官方控制台显示的是**账户级总消费**，本插件的工作区行显示的是**当前 canonical cwd 的工作区**，两者口径不同。对账接口：

```text
GET /dsh-whale-widget/cost-reconciliation?sessionId=...
```

返回：

- `currentWorkspace`：当前工作区 total/sessionCount；
- `allLocalWorkspaces`：本机所有工作区，按 sessionId 去重；
- `allLocalTotal`：本地所有工作区合计；
- `otherWorkspaceTotal`：本地其他工作区合计；
- `currentSession`：当前会话 total/currentTurn；
- `generatedAt`：采样时间。

它能区分“另一个工作区”的差额；官方仍包含 DSH 之外 API 调用、在途请求或尚未写入本地日志的 usage，剩余小差额需官方账单明细定责。README 不承诺插件总额等于账户级总消费。

## 费用公式

```text
CNY = (
  cacheReadTokens × cacheReadPrice
  + (uncachedInputTokens + cacheWriteTokens) × inputPrice
  + outputTokens × outputPrice
) / 1,000,000
```

`cacheReadPrice`、`inputPrice`、`outputPrice` 直接取该模型对应高峰或空闲的人民币单价。`cacheWriteTokens` 按输入价计费。

## 历史会话逐条计价

Cold Session 不再用 tokenUsage 汇总乘当前时段：

1. `sessionQuery.readSession()` 异步读取完整事件流；
2. 遍历 `assistant/message` / `assistant/attempt`，用 `usageOfEvent()` 取每条 usage；
3. 用该条事件的 `event.time` 判断当时的 Beijing 峰谷/节假日；
4. 用该条 usage 的四桶计算费用并累加；
5. `currentTurnCny` 同样来自逐条 total 与最近 `user/message` 基准的差值。

`toEpochMs()` 支持：

- epoch 毫秒/数字；
- ISO 字符串（带 `Z` 或 `+08:00`）；
- 无时区的 ISO 字符串按 `+08:00`（北京时间）解释。

### 历史缓存

Cold 结果缓存键绑定：

- `sessionPersistence.stat()` 的 `revision`；
- 文件 `mtimeMs`；
- 当前计价引擎的 `cacheVersion`（价目表和节假日表每次刷新都会递增）。

任一变化才重新逐条解析；否则直接复用金额。

长日志每 512 个事件 `await setImmediate` 让出事件循环，不会长时间占满 Host 主线程。

### 查看逐条明细

```js
const root = document.querySelector('.dsw-whale-root')
const token = globalThis.__DSH_WHALE_COST_TOKEN__
const sessionId = root.dataset.sessionId
fetch(`/dsh-whale-widget/usage-breakdown?sessionId=${encodeURIComponent(sessionId)}&limit=500`, {
  headers: { 'x-dsh-whale-cost-token': token },
}).then(r => r.json()).then(console.log)
```

返回：

- `totalCny`：与 `session-cost` 的逐条总费用一致；
- `buckets.peak/offPeak/holiday`：各时段的应用条目数和费用；
- `entries[]`：`beijingTime`、`beijingDate`、`period`、`holiday`、`usage`、`costCny`、`replaced`；
- 默认只返回最近 200 条，`limit` 最大 1000；`buckets`/`totalCny` 仍按全部条目计算；
- `invalidTimeCount`：时间无法解析的 usage 条数；这些条目的 `costCny` 为 0、`period` 为 `unknown`。

验证跨白天/晚上会话时，查看 `entries` 中不同 `beijingTime` 的 `period` 与 `costCny`，再用 `buckets` 或 `totalCny` 求和。

## 余额展示

余额与官网保持一致，采用**向下截断到分**：

- 同一币种的多个钱包先求和，再统一截断一次；
- `7.155` 显示为 `7.15`；
- 充值余额与赠金分开展示，不把赠金混入充值余额；
- `formatCny` 复用同一格式化，悬浮球费用与面板金额规则一致。

## 性能与加载

- `whaleCost` 通过 750ms 节流 + `React.startTransition` 更新；
- 悬浮球/面板金额使用 12px/14px 原生 CSS Spinner；
- Spinner 轨道用 `--dsw-alias-label-secondary`，顶部弧线用 `--dsw-alias-brand-primary`，深浅色主题自动适配；
- 金额出现时 `opacity + translateY` 淡入；
- 面板四行都有独立 loading/error 状态；
- 胶囊已移出浮动层，无 `backdrop-filter`，鲸鱼仅 transform 浮动；
- 拖拽位置用 `requestAnimationFrame` 合并；
- 冷会话每 512 个事件让出事件循环，工作区每处理一个会话让出一次；
- 工作区总费用只读取 `whaleCost` total，不遍历 tokenUsage/model；完整 tokenUsage/model 只给 `/session-cost`；
- Cold 缓存是最近 100 个会话的 LRU，价目/节假日刷新通过 `cacheVersion` 使旧条目失效；
- 余额等待与工作区 `fetch` 都有 10 秒超时；关闭面板会 abort 当前请求，requestId 防止过期结果写回；
- 面板保持打开时，工作区总费用每 15 秒静默刷新一次；页面重新可见和整轮结束时也会刷新；
- 静默刷新失败时保留上一次成功金额，不会把面板金额重置为 0。

## 架构

### Client

- `useSessions` 找当前会话；
- `faceOf('whaleCost')` 读 `{ totalCny, currentTurnCny, turnSeq, invalidTimeCount }`；
- `useSessionStatus` 监听该会话 `running`，在 true -> false 时触发整轮 `+¥` 闪烁；
- `useThrottledCost` 以 750ms 节流；
- 面板打开时读取余额并请求工作区总费用，三者互不阻塞；余额和工作区请求各有 10 秒超时，关闭面板会 abort；
- 面板打开期间工作区每 15 秒刷新，整轮结束和页面重新可见时也会刷新。

### Host

- `whaleCost` projection，`stateVersion=5`，`startSeq` 跳过 fork 继承前缀，输出总费用/本轮费用/turnSeq/invalidTimeCount；
- `/dsh-whale-widget/workspace-cost`：Host 侧只汇总当前工作区的 total；
- `/dsh-whale-widget/cost-reconciliation`：当前工作区 / 其他工作区 / 全部本地工作区的对账快照；
- `/dsh-whale-widget/session-cost`：单会话完整调试（tokenUsage/model/price）；
- `/dsh-whale-widget/usage-breakdown`：逐条 usage 的时间、时段、费用明细；
- `/dsh-whale-widget/pricing-info`：价目源、缓存、错误；
- `/dsh-whale-widget/holiday-info`：节假日源、缓存、错误；
- pricing/holiday 各有一个 24 小时定时器和在途锁，Host 卸载时由 `ctx.effect` 清理。

## 验证

```bash
node scripts/verify-pricing.mjs
node scripts/verify-formatting.mjs
node scripts/verify-client-cost.mjs
node scripts/verify-client-refresh.mjs
node scripts/verify-holidays.mjs
node scripts/verify-historical.mjs
node scripts/verify-pricing-parser.mjs
node scripts/verify-reconciliation.mjs
node scripts/verify-host.mjs
```

覆盖：

- 人民币价目、峰谷、替换/retry、fork 继承前缀跳过、无效时间按 0 并计数；
- 余额截断、多钱包求和与常见货币符号；
- Client 对 `{ totalCny, currentTurnCny, turnSeq, invalidTimeCount }` wire 的解析；
- Client 工作区 15 秒刷新常量；
- 2024–2026 保底节假日、法定假日/调休补班判断；
- 白天高峰 + 晚上空闲的历史会话逐条计时求和；
- 官方价目 HTML fixture 的正常解析和失败降级；
- 两个本地工作区的对账：共享 sessionId 去重、当前/其他/全部本地总额；
- Host projection wire、六条路由、token 注入，以及两个 24 小时定时器随 Host effect 卸载清理。

### 确认降级

```js
fetch(location.origin + '/dsh-whale-widget/pricing-info').then(r => r.json()).then(console.log)
fetch(location.origin + '/dsh-whale-widget/holiday-info').then(r => r.json()).then(console.log)
```

或查看 Host 日志和本地缓存文件：

```text
$DSH_PROFILE_DIR（若设置）或 $DSH_HOME/cache/dsh-whale-widget/pricing.json
$DSH_PROFILE_DIR（若设置）或 $DSH_HOME/cache/dsh-whale-widget/pricing-meta.json
$DSH_PROFILE_DIR（若设置）或 $DSH_HOME/cache/dsh-whale-widget/holidays/{year}.json
$DSH_PROFILE_DIR（若设置）或 $DSH_HOME/cache/dsh-whale-widget/holiday-meta.json
```

## License

MIT © 2026 Rajki22

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle、Client 依赖和发行文件 |
| `cordis.patch.yml` | 向 profile 插入 `deepseek-whale-widget` |
| `index.js` | Host：projection、工作区/调试/价目/节假日路由、24h 刷新调度 |
| `cache.js` | 缓存路径、异步 JSON 读写、临时文件 + rename 原子写 |
| `time.js` | 北京时间偏移、ISO/epoch 解析、日期键 |
| `usage.js` | 单一 usage event 解释器与 `usageSampleIterator` |
| `cost.js` | `whaleCost` schema、费用/usage 折叠、Cold 折叠与 wire view |
| `pricing.js` | 价目表模型、峰谷/节假日判断、费用引擎 |
| `pricing-source.js` | 官方价目抓取、解析、24h 缓存与后台刷新 |
| `pricing/deepseek.json` | 价目保底 |
| `holidays.js` | 节假日缓存、抓取、保底与每日检查 |
| `holidays/2024.json` … `2026.json` | 2024–2026 保底节假日 |
| `client.js` | 鲸鱼、面板、拖拽、Spinner、本轮闪烁、请求超时/取消 |
| `scripts/verify-*.mjs` | 价目/格式化/节假日/解析器/Host 自检 |
| `scripts/fixtures/pricing-page.html` | 官方价目解析 fixture |
| `assets/deepseek-whale.png` | 透明鲸鱼图，同时作为插件图标 |
| `locale/*.json` | 插件标题、描述与界面文案 |

## 已知边界

- GitHub raw 在当前网络可能不可达；节假日会静默使用内置/cache。次年在 11 月后可能返回 404，同样保留旧数据。
- 官方价目页结构变化时解析会失败，保留旧缓存/内置表；状态可通过 `pricing-info.lastError` 确认。
- 价目/节假日的 live 刷新只影响后续 usage；已经折叠的 live 历史不会追溯重算，cold 重算会使用当前表。
- 法定节假日数据来自第三方社区维护的 holiday-cn；如公告更新，下一次每日检查会刷新缓存。
- 找不到模型价目时该条 usage 费用按 0 计。
- `event.time` 无法解析时该条 usage 费用按 0 计，并增加 `invalidTimeCount`；不会猜测当前时段。
- Cold 缓存最多保留最近 100 个会话；被淘汰后下次请求会重新逐条折叠。
