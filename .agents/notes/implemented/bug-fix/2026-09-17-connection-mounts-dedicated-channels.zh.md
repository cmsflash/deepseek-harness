# Agent Note：Connection 在自身载体上挂载专用 RPC 频道

Status: implemented

[English](2026-09-17-connection-mounts-dedicated-channels.md) | 中文

## 问题

`connection.rpc.handle(channel, handler)` 过去通过调用方的 context 注册物理路由：`owner.webServer.register(route)`。在严格注入的 Context 代理下，从 `inject` 未声明 `webServer` 的 fiber 读取 `ctx.webServer` 会抛出 `cannot get property "webServer" without inject`。`rpc.handle` 的契约只把 `connection` 记为注册方的依赖，因此按该契约编写的插件在加载时失败。Connection 自身的 `inject` 从 `['webServer']` 改为 `['credentials']` 之后，生产 Web profile 中的两个外部插件正是这样失败的，而其中任何一个失败都会让整棵 Loader 树加载失败。

## 决定

`HostConnectionService` 自己保存已注册的频道，并把每个频道挂载到 Connection 在自身 `ctx.inject(['webServer'], …)` 块中、与共享 `/api` 路由一起附加的 Web 载体上。注册方的 fiber 只拥有注册这一 effect：释放注册方即移除频道；重复的频道名在注册时抛错。载体尚不存在时注册的频道会在载体到达时挂载；卸下载体会卸载全部频道但保留注册，因此下一个载体会再次服务它们。

`rpc.handle` 的 JSDoc、包 README 和一份 REAL-composition 规格（`tests/dedicated-channel.host.spec.ts`：经 Loader 启动的 `cordis.yml`，其注册方只注入 `connection`，并在运行中的 HTTP 服务器上验证）共同钉住该契约。该规格在旧实现上失败，注册方 fiber 处于 failed 状态。

## 曾考虑的替代方案

**要求每个注册方在 `inject` 中加入 `webServer`。** 这只能逐个修补插件，让文档化的契约继续错误，并且仍把频道寿命绑在注册方并不拥有的载体上：比载体更替活得更久的注册方会留下过期路由。

**在调用点通过 `ctx.get('webServer')` 读取。** 可选读取避免了代理错误，但在载体缺失或稍后到达时会静默地什么也不注册——这正是生产事故中"路由消失却无诊断"的失败形态。

**经共享 `/api` 拦截器挂载频道。** 专用频道存在的意义正是让插件拥有一个前缀而不必争夺唯一的 `/api` 拦截器席位；合并进去会改变外部插件已在使用的 wire 路径。

## 后果

注册方只注入 `connection`，与文档化的契约及既有的 `fetch.register` 行为一致。频道挂载跟随载体的寿命，因此 HMR 期间更换 Web 服务器会重新服务每个已注册频道。[传输分层记录](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)仍是各包拥有哪些路由的权威；本记录只把专用频道的物理挂载从注册方的 context 移到 Connection 的载体。
