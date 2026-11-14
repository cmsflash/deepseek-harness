---
description: "为 dsh Web 客户端保留经过链校验的会话存储行副本：IndexedDB 存储、每个源一个下载器，以及由副本服务的会话历史读取。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-local-copy

[English](README.md) | 中文

## 概述

使用本包为每个普通线程在浏览器 IndexedDB 中保留一份经过校验的本地存储行副本，并从该副本服务完整线程的历史，而无须先询问 Host：重新打开的标签页立即渲染（离线时同样如此），一个设备级内存预算约束在用 Session 持有的内容。副本未覆盖的读取原样回退到 Host。插件在安全的浏览器上下文中为每个标签页运行一个 worker，并在源级锁下以后台方式下载。

## 目录

- [存储内容与位置](#what-is-stored-and-where)
- [预算与配置](#budgets-and-configuration)
- [下载策略](#download-policy)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-is-stored-and-where"></a>
## 存储内容与位置

每个源都保留自己的 `dsh-local-copy` IndexedDB 数据库：

- `threads` — 每个线程一条记录：header 行及其链接值、head seq 与链接值、已存储行字节、分片数、最近见到的 Host cursor、副本状态（`downloading`、`complete`、`unverifiable`、`paused`）、最近一次问题、打开与同步时间，以及其最近一次下载所依据的会话列表活动。
- `chunks` — 存储行以至多 1 MiB 的 UTF-8 分片记录保存，键为 `[sessionId, firstSeq]`，并带每行的结束偏移及其 32 字节链接值。每次写入都在一个事务里存储分片并更新线程记录，先比较已存 head，因此竞态落败的标签页不会碰另一标签页的副本。
- `meta` — schema 版本与离线回放迁移标记。

副本只保存 Host 针对其会话日志链校验过的行：下载从存储的上一链接值核对每行的链接值，live 或 resumed 行只有接续已存 head 时才会被追加。

存储错误只让发生它的那次读取或写入失败；失败的读取以浏览器的错误名（例如 `UnknownError` 或 `QuotaExceededError`）作为错误码送到页面，Session 随即改从 Host 读取。浏览器关闭连接后（iOS 挂起之后，或另一标签页打开了更新的 schema）以及打开失败后，worker 会重新打开数据库，因此两者都不会让标签页在重新加载前失去副本。

完整副本会立即响应 Session 的打开；尚未保存完整日志的副本只在 Host 不可达时响应，并把其打开页标记为 `partial`。此后 Session 报告 `incompleteCopy`，直到 Host 的打开确认该窗口；在此期间 Chat 的离线提示会追加"此会话的已保存副本不完整。"

<a id="budgets-and-configuration"></a>
## 预算与配置

默认值跟随设备（粗指针加短边小于 600 px）：

| 设置 | 桌面 | 手机 |
| --- | --- | --- |
| `scope` | `all` | `opened` |
| `memoryBudgetBytes` | 104,857,600 | 26,214,400 |
| `diskBudgetBytes` | 0（不限） | 1,073,741,824 |
| `chunkBytes` | 1,048,576 | 1,048,576 |
| `minPauseMs` | 100 | 300 |
| `warmFollowGraceMs` | 30,000 | 30,000 |
| `readerLoadGraceMs` | 30,000 | 30,000 |
| `enabled` | true | true |

由于插件的浏览器半边无法通过 profile patch 配置，生效值在启动时从 `localStorage['dsh.localCopy']` 读取：一个 JSON 对象，可携带上述任意字段，并按同一 schema 校验；无效值会被忽略并给出警告。

<a id="download-policy"></a>
## 下载策略

每个标签页的专属 worker 在源级 Web Lock `dsh-local-copy/download` 下一次只下载一个线程的一个分片，并且不早于启动后三秒开始，以免与页面请求竞争。队列顺序是：本标签页打开的线程，然后是本设备上最近打开的线程，再（scope 为 `all` 时）是会话列表中其余普通、未归档的 Session，按最近活动优先。每个分片之后，循环等待 `minPauseMs` 与其自身忙碌时间四倍中的较大者。会话列表报告了完整副本最近一次下载所未依据的活动时，该副本重新进入队列：更晚的提示、运行状态的变化，或超过已存储 head 的投影水位。这次刷新只获取已存储 head 之后的行，像任何续接一样从其链接值开始核对，因此关闭的线程在页面列表报告的每次提示与每次轮次结束后都是最新的；轮次进行中，副本停在该轮开始处，直到下一次这样的报告或线程被打开。scope 为 `opened` 时，只刷新在本设备上打开过的线程。

失败处理：链不匹配或某行无法核对时，线程置为 `unverifiable`，至多每小时重试（线程被打开时立即重试）；Host 拒绝提供行或返回其他 4xx 状态时暂停十分钟；网络错误、5xx 以及 404、401 或 403（重启中或重新认证中的 Host 的应答）从 1 秒退避到 5 分钟；其他任何使某线程一轮下载失败的情况（例如响应格式错误或存储错误）都会让该线程暂停十分钟，队列继续处理后面的线程，打开该线程会立即重试。`diskBudgetBytes` 大于零时，worker 在存储每个分片前先腾出空间：按最久未打开的顺序删除整份副本（绝不删除最近 10 分钟内打开过的），仍放不下时线程以配额问题暂停；浏览器抛出 `QuotaExceededError`（无论来自写入本身还是其被中止的事务）时执行同样的删除（未设置预算时不删除）并重试一次写入，之后暂停。以配额问题暂停的线程在再次被打开之前不会被队列处理。线程的打开时间在每次打开时刷新，因此淘汰总是先删最久未打开的副本。

<a id="model-experience"></a>
## 模型体验

无，因为该插件在浏览器存储中存储并提供会话存储行，不注册任何模型可见内容。

#### KV Cache 影响

无；该插件存储并提供存储行，不组装任何提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- iOS 的 ITP 可能在连续 7 天未访问站点后删除整份副本；主屏幕 Web App 保留一份单独的副本。
- subagent 子线程不复制。
- 桌面应用被排除（检测 `dshDesktop`）；仅浏览器存储。
- 存储分片不压缩。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
