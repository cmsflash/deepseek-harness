# Agent Note: 输入框 attach 席位与外置回形针插件

Status: implemented

[English](2026-08-31-composer-attach-seat.md) | 中文

## Problem

输入框只接受两种图片手势 —— 文本域粘贴和文档级拖放。没有任何点击浏览路径：整个客户端不存在 `<input type="file">`，工具行的 `+` 按钮是斜杠命令菜单。两处已发布的文档注释（`ModelsSection.tsx` 的 "Same glyph as the composer's attach button"；`conversation.input.left` 槽位文档的 "access mode, plan, attach" 常驻控件）早已承诺了一个并不存在的按钮。

把按钮做进 `ui-attachment` 被席位/能力分离挡住：小型常驻控件的天然位置是工具行席位，但工具行的 owner 份额（`InputZone`）只携带 `{ session, input }` —— 没有图片入口。入口（`addImages`）位于 `ComposerBarInjected`，是 ui-conversation 的包内私有面，而跨包符号导入被禁止。唯一携带入口的槽位 `conversation.input.attachments` 是 `single` 占用且已被持有，占据它意味着以另一优先级遮蔽并重渲染缩略图栏、拖放遮罩和灯箱 —— 一个 20 行的功能继承了三个组件。

## Decision

ui-conversation 在工具行中紧邻 plan 和 model 声明新命名席位 `conversation.input.attach`（`single`，`session` 作用域），owner 份额为 `ComposerAttachOwnerProps`：`locked`、`canAddImages`、`onAddImages` 和 `acceptedMediaTypes`。渲染点传入 `intakeImages` 本身 —— 与支撑粘贴和拖放相同的回调 —— 并以 `canAcceptDrop` 作为 `canAddImages`（两者是同一个"现在图片能否进入草稿"的事实），以 `imageLimits.mediaTypes` 作为选择器的 `accept` 过滤。拾取入口因此免费获得校验和拒绝提示，且永远无法与其他手势分叉。

按钮本体作为外置插件发布，`~/Programs/dsh-plugins/dsh-local-image-upload`（`@dsh-external/dsh-local-image-upload`），沿用 read-aloud 先例：一个纯浏览器 bundle，其 client 半将 `AttachButton` 注册进席位；一个隐藏的多选文件输入按 `acceptedMediaTypes` 过滤，每次拾取后重置 `value`，使重复拾取同一文件仍触发 `change`。仓库 diff 仅为槽位接缝；消费者是私有的。承诺 "attach" 的两处文档注释现在描述一个真实席位。

## Alternatives considered

- **从插件遮蔽 `conversation.input.attachments`。** 否决：遮蔽即替换，插件将继承重渲染缩略图栏、遮罩和灯箱；已被标记 `shadows-shipped-ui`。
- **把按钮放进工具行并加宽 `InputZone` owner。** 否决：入口不是整个工具行的事实，为了一个条目的回调加宽列表槽位 owner 份额会诱使每个条目去抓取它。
- **在仓库内发布按钮为 `ui-attach-local`。** 由所有者推迟：接缝公开且稳定，外置消费者是当前需求，之后添加仓库内包无需再动接缝。

## Consequences

- 该席位是一个只有私有消费者的公开组合面。这一张力是所有者的明确选择；仓库内消费者之后可通过普通注册占据该席位。
- `conversation.input.attach` 与 plan/model 一样是 `session` 作用域，无会话时席位不渲染 —— 这是正确的，因为此时入口本就未定义。
- slot-catalog 生成器输出新增该席位行，`cordis_inspect what:"client"` 现在会把它广播给探测该表面的任何模型。
- 外置插件的类型 shim 重新声明 owner props；shim 与真实契约的漂移只被它自己的 typecheck 捕获，不被仓库的捕获。接缝类型（owner props 接口）是需要盯住的稳定契约。
