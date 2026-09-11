# Agent Note: 折叠的右侧面板不计入 frame 溢出

Status: implemented

[English](2026-09-11-collapsed-rightbar-frame-overflow.md) | 中文

## Problem

右侧 Sidebar 折叠时面板仍保持挂载，宽度不变并平移到 frame 右边缘之外（[停靠基础设施](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)）。frame 的零宽右列不裁切，frame 自身又使用 `overflow: hidden`，Chromium 将其视为滚动容器。因此隐藏面板把 frame 的可滚动溢出扩大了一个面板宽度：会话文本在右侧被截短，首次点击 Composer 触发的浏览器 `focus()` 滚动把 `frame.scrollLeft` 设为该宽度，左侧 Sidebar 与会话移出视口，而 frame 自身的盒子并未移动。

## Decision

`AppFrame.module.css` 以永不可滚动的 `overflow: clip` 裁切 frame，并新增 `.frame[data-rightbar-collapsed] .rightbarCol { overflow: clip }`，让关闭的列把已挂载的隐藏面板裁出 frame 的溢出范围。存在轨道时 `.rightbarCol` 保持 `overflow: visible`，打开中的面板仍可从窄列悬在会话之上。关闭滑动不受影响：轨道与面板的 transform 走同一条过渡曲线，面板左边缘始终贴着列的左边缘直到两者到达 frame 边缘。全屏面板为 `position: fixed`，在两处裁切之外。移动端布局对该列的 `display: none` 不变。

## Alternatives considered

**折叠时卸载面板。** 停靠基础设施保持面板挂载，以便标签状态跨折叠保留、显示与隐藏是同一次滑动；卸载会推翻该决定。

**每次 Composer 聚焦都加 `preventScroll`。** Composer 自身路径已用 `preventScroll` 聚焦；出问题的是用户点击时浏览器的默认滚动，而任何列里的 `scrollIntoView` 仍会移动 frame。frame 自身的溢出是唯一的归属方。

**在所有状态下裁切该列。** 打开滑动从零或很窄的轨道开始，面板必须悬在会话之上直到轨道跟上；此时裁切会在滑动途中把面板切成轨道宽度。

## Consequences

面板折叠时 frame 不产生水平溢出，任何后代的滚动都无法移动其各列。[样式表断言](../../../../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts)固定三条溢出规则；[组装浏览器用例](../../../../apps/web/tests/sidebar-right.e2e.ts)断言 frame 边缘外存在宽的隐藏面板、聚焦 Composer 前后 frame 可滚动宽度为零、各列盒子不变，以及程序写入后 `scrollLeft` 读回为零。ui-layout README 记录该裁切约定。
