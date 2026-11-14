# Agent Note: 浏览器本地 Session 副本

Status: implemented

[English](2026-11-07-browser-local-session-copy.md) | 中文

## 问题

一个 Web 线程只存在于 Host 上。每次重新打开——新标签页、导航往返、刷新——都要从 Host 重发整个开场窗口，因此首条对话记录要等待网络；Host 不可达期间读线程，只能看到离线回放所记录的内容。这些记录既无法校验也无法复用：它存的是解码后的帧，而不是存储的日志文本，其中任何内容都无法对照[会话日志链](../../../../packages/session/session-persistence/README.zh.md#the-session-log-chain)核对；繁忙线程每秒都会整体重写自己的已记录窗口；快照形状的记录还会替换读者已加载的页面。内存也无上界：释放一个 Session 会销毁其窗口，回到一个线程就要再次付出整个快照的代价，且没有任何机制限制一个页面中在用 Session 持有的正文文本。

## 决策

Host 只提供它能证明的存储行。持久化链暴露 `storedLine(event)`：它重新编码该事件，仅当字节的 SHA-256 摘要等于该 seq 处的链条链接值时才返回这些字节，因此读取方无需持有存储行即可提供存储字节；读迁移的日志会获得一条覆盖其后继发布所写 header 与事件行的链，因此其链接值就是后继将拥有的链接值（链条的定义见[可恢复 follow](2026-11-03-resumable-session-follow.zh.md)）。鉴权路由 `GET /api/session/lines` 从旧到新提供一段存储行：一行 `SessionLinesHead` 之后是原始 JSONL；`have` 检查点让浏览器提交至多 32 个它已持有的 `seq:link` 对，路由从最高一致检查点之后一位继续，从而定位一个已分歧的副本最后一次与 Host 一致的位置。`session/follow` 新增 `lines: true`：`resumed` 开场的每条 record 与每个 live 事件帧都成为携带相同链接值的行条目；快照开场仍携带解码 record。

浏览器保留副本。`dsh-client-local-copy` 客户端插件从 Blob IIFE bundle 为每个标签页运行一个专属 worker，IndexedDB 数据库 `dsh-local-copy` 把每个线程存为至多 1 MiB 的 UTF-8 行字节分片记录，每行带一个 32 字节链接值；写入在单个事务里对线程的已存 head 与 head 链接值做 compare-and-swap，两个标签页无法交错写入分片。每个源只有一个下载器持有 Web Lock `dsh-local-copy/download`；它一次只下载一个线程、一个分片，发送自己的检查点，用 `crypto.subtle` 从存储的上一链接值起逐行哈希，每个分片后至少等待 `minPauseMs` 或者该分片自身忙碌时间的四倍，并且不早于页面启动后三秒开始，因此从不与启动竞争。链接值不匹配会把该线程标记为 `unverifiable` 并重新排队一次修复，从最高一致检查点续传；header 被改写则从第零字节替换整个副本。live 与 resumed 行条目按同一检查追加进副本，所有链检查共用同一个字节比较：每行必须从存储的 head 链接值起哈希并接续其 seq。

Session 从副本打开。`ClientSessions.registerHistorySource` 安装副本；插件同步注册该来源，每次调用等待其 IndexedDB 探测，探测失败按无副本应答，因此离线启动期间打开的 Session 仍会询问副本（每页面一个注册，仅普通 Session）。线程拥有完整副本的 Session 立即从磁盘发布最新窗口并标记 `unconfirmed`，再以副本头部为恢复点打开 `follow`，因此未变化的线程只传输 resumed 开场的各基线。首个远端开启清除 `unconfirmed`；替换本地所开窗口的快照会上报分歧，worker 随即修复副本。更早的翻页、步骤展开与全量区间读取先读副本，副本未覆盖的读取原样回退到 Host。

折叠在浏览器中为副本支撑的窗口执行。分页、保留、digest 与轮次核算代码移入 `history-shared`（内联进 worker bundle，因为 Blob worker 无法解析 workspace 包），因此 worker 构建的页面与 Host 构建的相同（[折叠步骤 digest 分页](2026-09-01-collapsed-step-digest-paging.zh.md)）；保留与 digest 只需要完整轮次，因此 worker 只对页面相交的轮次计算它们，并从磁盘展开被省略的步骤。重量级部分被压缩：从副本读取的流式记录被截断到首 token 前缀并标记 `stripped`，直到 `requireFullHistory` 以完整细节重读窗口整个区间；`request/header` 记录携带 `headerKey`，因此一个 Session 每种内容只保留一个 header 对象，而不是每个事件一个。

释放的内存有界而不是被丢弃。注册历史源时，普通、已打开且最后一个引用释放的 Session 照常销毁其 scope 和 binding 自有的 UI 状态，但把 Session 对象连同窗口和 follow 放进 warm 池——经过 `warmFollowGraceMs`（默认 30 秒）后其 follow 暂停——之后的 `retain` 为该 Session 绑定新的 scope，通过 journal 的 `adopt` 以最新持有记录重新打开 follow（所有权规则见[Client 会话引用](2026-09-15-client-session-references.zh.md)；本决策只改变最终释放的后果）。一个设备级预算（`memoryBudgetBytes`，桌面默认 100 MiB，手机 25 MiB）约束在用 Session 持有的正文文本；窗口变化后的空闲回合每次淘汰一个 Session 最旧的一页，先 warm Session，再按该页上次查看时间排序，绝不触碰与已上报视口相交或在其之后的页，也不在 `readerLoadGraceMs`（默认 30 秒）内触碰读者自己加载更早历史所加入的页，Chat 的滚动上报至多每秒一次标记视口位置。受此保护的页及其与视口之间的页在保护结束之前可以使总量超出预算。

设备策略与离线行为都建立在副本之上。桌面下载列表中每个普通线程（`scope: 'all'`）；手机在 1 GiB 磁盘预算下只保留在那里打开过的线程，优先删除最久未打开的副本（绝不删除最近 10 分钟内打开过的），页面隐藏时暂停。离线回放不再记录或回放 `session/follow`：已持有的会话记录来自本地副本；回放期间，携带恢复点的 follow 保持打开但不推送条目直到主机恢复，不带恢复点的以载体故障失败。`ctx.remote.$offline` 驱动"离线"连接标识与 Chat 提示；尚未保存完整日志的副本只在主机不可达时打开，其打开页标记为 `partial`，此时提示会追加已保存副本不完整，直到主机的打开确认该窗口（Session 快照的 `incompleteCopy`）。重连开销落在控制流上：每个连接 generation 只打开一次 `session/control`，发送 `asOfSeq` 与链条链接值的 `known` 检查点，baseline 把未变化的 Session 省入 `retained`（投影所有权见[会话观察](2026-08-25-session-observations-and-projection-owned-client-state.zh.md)）。

## 考虑过的替代方案

**OPFS。** sync access handle 每文件一个，只服务单读取方，iOS 缺少 `mode` 选项，隐私浏览模式直接失败；IndexedDB 分片记录可被源内所有标签页读取，并可存活于标签页之外。

**按行记录。** 实测 CPU 约为分片记录的 7 倍，吞吐 53–67 MB/s；桌面 Chromium 上 1 MiB 分片写入 546 MB/s，每 GiB 几千条记录也让 cursor 遍历保持短暂。

**@noble/hashes。** Chromium 上 `crypto.subtle` 以 441 MB/s 哈希，而它只有 85–206 MB/s，还引入依赖；worker 顺序摘要，await 无关紧要。

**在浏览器中哈希重新编码的事件。** 在浏览器重新编码的解码事件未必复现存储字节，浏览器也无法运行基于 Node 的 codec；Host 通过校验它能证明的字节保持唯一定义。

**压缩分片。** 每分片 deflate-raw 可以缩小副本，但 Chrome 的新 IndexedDB 后端本身不再压缩取值；存储大小约为正文文本，压缩留作手机端的后续选项。

**在 WebSocket 帧内发送行。** 行在帧内做 JSON 转义约增加 10%，慢读取方还会阻塞 socket 的其他流；批量行走 HTTP 通道，既有的 gzip 中间件会压缩 `text/*` 响应。

**把 header 留在磁盘。** Chat 的工具变更分类需要读取每个 header 的完整工具列表，surface 校验器也拒绝空的 `header.tools`；对每种内容共享一个内存 header 对象保住了默认视图，并省下每月约 0.53 GiB header 开销的大头。

**固定数量的 warm 线程。** `warm-threads` 分支保留 8 个最近离开的 Session 并保持 follow 打开；Zhuoran 于 2026 年 11 月 3 日否决了它（切回 79–120 ms，绘制占主导）。字节预算改为保留无限量的 warm Session，由内存而非数量约束。

**Host 全局事件流。** 单独的全局事件流会把每个线程的字节在一个连接上多次搬运；按线程的 follow 加恢复点保住了既有协议及其缺口检查。

## 后果

历史日志的一次冷读取现在要多付一次编码加哈希的扫描（Node 约 1.9 GB/s 哈希），Host 提供存储行时每请求重新编码一次。副本以明文保存在浏览器存储中，与离线回放相同；Safari 的 ITP 会在连续 7 天未访问站点后删除它，主屏幕 Web App 保留一份单独且豁免的副本。subagent 子线程不复制，Desktop 应用禁用该插件，本版本的存储分片不压缩。会话列表报告了完整副本最近一次下载所未依据的更晚提示、运行状态变化或超过其 head 的投影水位时，该副本重新进入下载队列，并只获取新的行；关闭的线程在页面列表报告的每次提示与轮次结束后都是最新的，而关闭线程的轮次进行中，副本停在该轮开始处。后续工作：`workspace/follow` 恢复（每次重连 87 KB）、`session/list`、`settings/describe` 及其余 `connection/reset` 监听器的条件化重取（约 69 KB，各自需要自己的修订）、基于摘要的 request-header 分类以便 header 留在磁盘，以及 Host 卸载。测试用 `node:crypto` 与字面量 tag 钉住链条，校验路由的检查点与字节预算行为、worker 页面与 Host 自身共享函数的一致性、warm 池复活与预算淘汰规则，以及经 lines 路由的端到端重开。
