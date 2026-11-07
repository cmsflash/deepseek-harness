# Agent Note: 可续接的 Session follow

Status: implemented

[English](2026-11-03-resumable-session-follow.md) | 中文

## 问题

每次 `session/follow` 重连，包括每次短暂断网和 Host 重启，都会发送一份最多 500 条消息的完整快照，尽管浏览器已经持有断线期间写入的事件之外的全部内容。快照会替换所持有的窗口，读者向上滚动加载的更早页面因此丢失。在慢速链路上，一份 3.8 MB 的快照主导了重连耗时；而为缩小快照压缩 WebSocket，会在浏览器与 Host 位于同一台机器时为每次开场每 MB 增加约 8 ms（2026 年 11 月 3 日的回环对比）。

仅凭 cursor 无法安全地接续窗口。live 事件在写入之前最多 200 ms 就会到达 follower，因此崩溃后 Host 会把这些 seq 复用给不同的事件；Session 格式迁移也会给事件重新编号。

## 决策

Host 为它持有的每份日志维护一条会话日志链：覆盖该日志各行确切存储字节的 SHA-256 链接值。header 链接值为 `SHA-256("dsh-session-chain/1" ‖ headerLine)`；seq 为 `n` 的事件的链接值为 `SHA-256(link(n − 1) ‖ line(n))`，其中前一个链接值以 32 个原始字节参与，一行是某条记录去掉换行符后的存储 UTF-8 字节（[定义](../../../../packages/session/session-persistence/README.zh.md#the-session-log-chain)）。JSONL 后端在读取日志时按每条已提交行的原始字节计算链接值，也在写句柄接受事件时计算：它把事件编码成行一次，对该 `Buffer` 计算链接值，稍后写入同一个 `Buffer`，因此 live 事件的链接值等于稍后读取时算出的链接值。对中断日志的冷读会用与写路径相同的编码，为它在内存中添加的轮次收尾事件计算链接值，这些链接值等于恢复后的 Agent 追加它们时存储的链接值，因此中断的线程能像其他线程一样续接。链接值随 Host 已持有的日志保存，即 live Session 的写句柄与冷读缓存，每个事件 32 字节（写句柄的缓冲区仍在增长时最多为其两倍）。

`follow`、`page` 与 `events` 提供的每条记录以及每个 live 事件帧，在日志有链时都携带 `link`；代表被省略事件的记录携带最后一个事件的链接值。重连的 follow 发送 `resume: { afterSeq, link }`，即其最新持有记录代表的最后 seq 与该记录的链接值。若 Host 在 `afterSeq` 处的链接值等于 `link`，且其后最多有 `followResumeEvents` 个事件（Session Controller 配置，默认 1,000；0 表示禁用续接），它以 `resumed` 开场应答，携带 `afterSeq` 之后的每个事件（完整细节），以及当前 header、projection baseline 与 Assistant baseline。其他所有情况都以完整快照开场，与不带续接点时完全一致；格式错误的续接点以 `gateway/bad-request` 失败。跨过晋升（promotion）仍保持打开的 follow 会在其第一个 live 事件处核对一次：live 日志在开场 cursor 处的链接值是否仍与开场时相同；若不同就结束该 generation，让 Client 重连并获得快照。

`RemoteJournalStream` 为设置了 `resumeEntries` 的领域负责 Client 侧：它保存最新持有的 entry，提交给每个重连的 generation，只接受接在该 generation 所获 cursor 之后的 `resumed` 开场，并以新 entry 发布 `resume` 变更。任何快照开场都会替换窗口，包括 cursor 落后于所持窗口的快照，因为崩溃之后以 Host 日志为准。`SessionEventStream` 只保留一个 entry 并提交它的链接值；最新记录没有 `link` 时以快照开场，而结束在所提交 seq、且携带所提交链接值的快照开场会续接所持窗口而不是替换它，因此回放其记录开场的离线阅读仍会保留读者已加载的页面。续接的重连保留 Session 的更早页面、step digest 和已展开的 turn，从新的 baseline 重建 live Assistant 行，并补入断线期间结束的 attempt 所暂存的 settlement。

离线回放给 `session/follow` 记录建键时不含请求的续接点，并把接续该记录的 `resumed` 开场折叠为一份快照，因此该记录仍从第一项开始回放。

## 考虑过的替代方案

**逐字段比较最新持有的事件。** 以 `{ seq, time, type }` 列出最新 16 个事件、再核对 header 的 `version` 与 `createdAt`，只检查了尾部少数几个字段：一份保留了这些值却丢失或改动了更早事件、或改动过事件内容的日志，仍会被接到所持窗口上。一个链接值覆盖 header 与截至 `afterSeq`（含）的每一个字节，而保存链接值每个事件只需 32 字节，写句柄的缓冲区仍在增长时最多为其两倍。

**只在写入后才为事件计算链接值。** live 事件在写入之前最多 200 ms 就已到达 follower，因此 live 帧不会携带链接值，live 事件之后的短时间内重连也无法续接。

**对重新编码的事件求哈希。** 重新编码一个已解码的事件未必能重现另一个构建或格式迁移写下的那些行的存储字节，而计划中的浏览器端日志副本（尚未实现）会对收到的存储文本求哈希；对存储字节求哈希让两者共用同一定义。

**压缩每次开场。** permessage-deflate 能把快照缩小到约四分之一，对远程客户端仍然有用；但它仍会重发浏览器已持有的内容，并在浏览器与 Host 位于同一台机器时为每次开场每 MB 增加约 8 ms（2026 年 11 月 3 日的回环对比），一个 3.8 MB 的 Session 需要 29 ms。

**仅凭 cursor 续接。** 单个 seq 无法发现崩溃复用或重新编号，续接的窗口可能悄无声息地拼接两份日志。

**组合 `observeEvent` 与 `events`。** live Assistant 帧只存在于 `follow`，`observeEvent` 没有 cursor，两次调用也会失去 header、事件、projection 与 Assistant baseline 共享的单一读取点。

**使用 Host 启动 epoch。** epoch 能发现重启，却无法得知哪些事件在重启后仍然存在，因此每次重启都会强制发送快照；链接值则让重连在所持事件已写入时跨重启续接。

**把续接的事件就地追加到已渲染窗口。** Session 以一次替换重新发布整个窗口，使 Assistant fold、暂存的 settlement 和提交回显都从同一份列表重建；重连足够少见，这次 Client 侧重建的代价低于再维护一条发布路径。

## 后果

重连只传输断线期间写入的事件以及 projection 和 Assistant baseline，并保留读者已加载的页面；Host 重启后，只要所持事件已写入，它仍会续接。每条记录因链接值增加约 74 字节，约占大型快照的 2%；冷读要为每一行求哈希，约每个 3.3 KB 事件 1.6 µs。Client 不校验链接值，它原样返回 Host 给出的链接值，该计划中的浏览器端副本会从收到的存储文本算出同一条链。没有链接值的记录无法作为续接起点：被格式迁移准备或发布的日志，要等到再次读取其当前 generation；以及由不保留链的持久化后端提供的日志。projection baseline 仍是完整的，因为 Client 在每次新连接时都会清除 projection 值；其中的 turn outline 每轮约增加 200 字节。`resumed` 开场不携带更早历史的边界或 step digest，因此不会改变 `hasMore`。只有当回放的开场结束在所持窗口时，窗口才能挺过离线阅读；在其开场之后还记录了 live 事件的离线副本回放的是更短的开场，它会替换窗口。若 Host 的日志丢失或改写了所持事件，它以快照应答，窗口可能因此后退；以前的 Client 会把这种重连当作协议违规而失败。

只有当 Client 仍持有窗口时，再次打开 Session 才会续接；导航释放的 Session 对象以快照开场。本决策部分取代 [Session 历史与事件传输](2026-08-18-session-history-and-event-transport.zh.md)和 [Session observation](2026-08-25-session-observations-and-projection-owned-client-state.zh.md) 两篇 Note 中的重连规则，它们的其他决策保持不变。
