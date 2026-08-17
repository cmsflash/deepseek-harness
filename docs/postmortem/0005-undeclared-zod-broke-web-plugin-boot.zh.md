# Post-mortem 0005: 未声明的 `zod` 导致 Web GUI 在浏览器启动时失败

[English](0005-undeclared-zod-broke-web-plugin-boot.md) | 中文

Status: resolved (fix on `wip/assistant-reply-read-aloud`)

## 执行摘要

一个新包导出了生成的 `./remote` 产物，却没有声明该产物 import 的 `zod`。所有宿主侧检查都通过，因为 pnpm 的提升存储在编译期能解析 `zod`，而浏览器的冻结模块表不能，于是装配后的 GUI 在启动时失败。修复声明了该依赖，并新增一条清单门禁：导出 `./remote` 即要求声明生成产物 import 的每个运行时依赖。

## 概述

加入朗读功能引入了 `@deepseek-ai/dsh-speech-cache`，其 `SpeechCacheService` 暴露一个 `@Remote('audio')` 方法。因此 Typert 生成了 `lib/typert.remote-client.js`，其首行是 `import { z } from 'zod'`——请求／结果编解码器都是 zod schema。而该包的 `dependencies` 只列了 `@deepseek-ai/schemastery`。

`tsc`、`oxlint`、13,505 个单元测试、`test:gui`、`build` 以及全部 28 个 `doc-sync` 门禁均通过。故障只在浏览器加载装配后的 shell 时出现。

## 影响

该分支被检出期间 Web GUI 无法启动。恢复需要回退到 `master` 并重新构建，这在 `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 下留下四个悬空符号链接，使 `dsh --profile web --dump-config` 一直以 1 退出，直到它们被移除。没有数据丢失：会话是持久的，且运行中的服务器在重启前一直用已加载的代码继续服务。

## 根因

生成产物会被内联进 import 它的那个 Client 包的浏览器 bundle——这里是 `@deepseek-ai/dsh-api-remotes`，经由新增的 `import speechCacheRemote from '@deepseek-ai/dsh-speech-cache/remote'`。bundle 纯度门禁明确允许这一点（`packages/client/tsdown.client.ts` 中的 `GENERATED_REMOTE`：「wire contribution: inline is the point」）。

内联是强制的而非可选的。`PLATFORM_MODULES`（`packages/client/web/src/platform.ts`）只含 React、cordis 与三个 UI 包；`clientConfig` 中的 `noExternal` 直接写明了规则——不在加载器模块表中的一切都必须内联，并把 zod 列为示例之一。

但打包器只能内联它能解析的东西，而 pnpm 的严格存储只为已声明的依赖建立符号链接。`packages/feedback/message-feedback/node_modules/zod` 存在，是因为那份清单声明了 zod；speech-cache 的对应目录从未被创建。于是 tsdown 在产出的工厂函数里留下一个裸 `require("zod")`，启动时 `makeRequire`（`packages/client/modules/src/client/system.ts`）依次走 seed → statics → cache → factories，全部未命中并抛错。它的消息本就点明了原因：「a build-time externals drift, or a forbidden cross-plugin value import」。

## 为什么所有宿主侧检查都通过

仓库根目录没有 `node_modules/zod`，但存在 `node_modules/.pnpm/node_modules/zod`。这条提升路径能满足 TypeScript 与 oxlint，因此一个从未声明该依赖的包在编译期也能解析成功。运行宿主代码的 Node 也以同样方式解析。只有浏览器——其冻结模块表是唯一解析器——才能区分「已声明」与「恰好可达」。

脚手架流程让这个遗漏很容易发生。该清单是复制 `message-feedback` 的字段集生成的，而 `zod` 被删掉的理由是：新包只用 schemastery 写 `Config`，别无他用——这在局部为真，但结论是错的，因为该依赖是为生成产物而存在，而非为 `src` 里的任何代码。

## 修复

`packages/speech/speech-cache/package.json` 声明 `"zod": "^4.4.3"`，与已导出 `./remote` 的全部五个包一致。它的 knip 条目按 `cordis-host-runner` 与 `commands` 的做法忽略该依赖，因为 `src` 下没有文件 import 它。

`scripts/check-workspace-constraints.ts` 新增 `generatedRemoteDependencyErrors`，断言带有规范 `./remote` 导出对的清单声明了 `GENERATED_REMOTE_RUNTIME_DEPENDENCIES` 的每个成员。该检查复用既有的 `hasTypertRemoteNavigation` 谓词，且该列表是常量，因此未来出现第二个生成 import 时只需改一行，而不必新增规则。`scripts/workspace-constraints.spec.ts` 证明该门禁会拒绝缺少依赖的清单、接受已声明的清单、忽略没有生成 remote 或采用手写 `./remote` 的包，并对全部六个已交付的 remote 包成立。

同一次排查发现了另一个同类遗漏：`tsconfig.base.json` 的 `paths` 映射里缺少 `@deepseek-ai/dsh-client-ui-message-speech`，`verify-cordis-config` 会报告它，因为 client 包名以其分组目录为前缀，无法被通用通配符匹配。

## 教训

**生成产物的 import 就是所属包的依赖。** 清单要求某个模块，并不需要 `src` 下有任何文件提到它。通过裁剪邻居清单来搭建新包恰恰是这条规则的破口，因为裁剪决定是靠读 `src` 做出的。

**编译期能解析不等于运行期能解析。** 提升存储让未声明的依赖对所有静态检查隐形。只有冻结模块表强制真正的规则，而它在浏览器启动时才这么做——正是发现故障代价最高的地方。

**只有一个产物遵循的规则需要门禁。** 已有五个包遵循这一约定，却没有任何检查。该约定只能通过比对清单发现，这也正是它最终被诊断出来、而非被预防的原因。
