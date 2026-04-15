---
title: "Twitter Ambient 一周野外试用 — Bookmarklet 方案"
status: ready
owner: claude
created: 2026-04-14
updated: 2026-04-14
implements: []
reviews: []
---

# Twitter Ambient 一周野外试用

## Context

Stage C 完成后暂停开发，**用一周真实 bookmark 推文验证产品价值**。七天后回来评估：
- 有没有期待每晚 22:00 通知
- 通知是信号还是噪音
- 决定是否做 Chrome 扩展 (Stage A 收尾) 和 Stage D

本文档记录试用期的 ingest 方案（Bookmarklet）和评估清单。

## 为什么用 Bookmarklet 不是 Chrome 扩展

- **轻**：30 行 JavaScript，浏览器书签栏一条，装卸不到 10 秒
- **不影响结论**：试用目的是验 "值不值得做 Chrome 扩展"。如果试用都嫌 bookmarklet 麻烦，Chrome 扩展就更别做了
- **token 已硬编码**：反正是给本机自己用

## 使用方式

### 1. 添加 Bookmarklet 到浏览器

Chrome / Safari 书签栏，新建书签，URL 粘贴 `extras/bookmarklet.js`（下方）的压缩版本。Title 随意，建议 "📌 Mantle"。

### 2. 日常操作

看到值得 mark 的推文时，**保持在推文的详情页**（URL 形如 `https://x.com/xxx/status/1234`），点书签栏的 "📌 Mantle" 一次。成功会弹一个 "✓ Sent to Mantle" 浏览器 alert（不优雅但直观）。

### 3. 每晚 22:00 等通知

Mantle 会自动处理所有未处理的 bookmark，挑出 top picks 通过系统通知推送。

## 评估清单（第 7 天回来勾选）

### 量化
- [ ] 这 7 天 ingest 了多少条？（`curl /bookmarks/status` 看 total）
- [ ] 有没有哪一晚通知没弹出？（记下异常原因）
- [ ] 点击通知后真的读了几条？

### 定性（诚实打分 1-5）
- [ ] 通知弹出那一秒的**信号感**（5=眼前一亮想点 / 1=下意识 dismiss）
- [ ] top picks 准不准（5=gemma 选的就是你自己会选的 / 1=完全错）
- [ ] 每晚 22:00 是不是**对的时间**（5=正好空下来 / 1=总是在忙）
- [ ] Bookmarks 窗口的 UI 有没有想再看（5=隔天还会主动打开 / 1=从来没再开过）

### 决策分叉
- 若 **信号感 + top picks 准确度** 均 ≥ 4 → **做 Chrome 扩展**（Stage A 收尾，一天工作量）
- 若两者都 ≤ 2 → **不做 Stage D**，项目可以停，复盘 26B 本地模型的边界
- 中间状态（3-4 之间）→ 再 push 两周看趋势

## Mantle 长期运行注意事项

- **必须 Mantle 保持运行**：关机 / quit 会错过 22:00 触发。建议：
  - Mantle 菜单栏 "Settings" → "Launch at Login" 打开
  - 每天不主动 quit Mantle（关 window 不等于 quit，⌘Q 才会）
- **LM Studio 必须保持运行**，且 gemma-4-26b-a4b 模型加载着。不然 agent-core 调用失败，daemon 会 skip 当晚 digest

## 快速自检命令

```bash
# 一周内任何时候想看状态
TOKEN=$(cat "$HOME/Library/Application Support/Mantle/extension-token")
curl -sS -H "X-Mantle-Token: $TOKEN" http://127.0.0.1:19816/bookmarks/status
# → {"total": N, "undigested": M}

# 手动 fire 一次当晚 digest（不等 22:00）
open "mantle://twitter/digest-daily-now"

# 直接开 Bookmarks 窗口
open "mantle://bookmarks"
```

## Bookmarklet 源码

见 `Mantle/extras/bookmarklet.js` 和 `Mantle/extras/bookmarklet.min.js`（压缩后粘贴用）。
