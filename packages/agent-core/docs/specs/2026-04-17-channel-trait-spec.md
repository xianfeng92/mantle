---
title: Channel Trait + Dispatch Layer
status: implemented
owner: claude
created: 2026-04-17
updated: 2026-04-17
implements:
  - src/channels/channel.ts
  - src/channels/dispatcher.ts
  - src/channels/draft.ts
  - src/channels/default-handler.ts
reviews: []
---

# Channel Trait + Dispatch Layer

ZeroClaw 的 Channel trait（30 种 IM 驱动的统一接口）在 Mantle 上的落地。

## 核心组件

| 组件 | 文件 | 职责 |
|---|---|---|
| `Channel` interface | `src/channels/channel.ts` | 统一 IM 驱动接口：`start(dispatcher)` / `stop()` / `send()` / draft 四阶段 |
| `ChannelMessage` | 同上 | 统一入站消息：id / channelName / scopeKey / replyTarget / text / images / threadId |
| `ChannelDispatcher` | `src/channels/dispatcher.ts` | Bounded async queue + scope-based preemption（同 scope 后来打断前一个，跨 scope 并行） |
| `DraftUpdater` | `src/channels/draft.ts` | Throttled streaming draft lifecycle：push(delta) → 定时 flush → finalize/cancel |
| `createDefaultHandler` | `src/channels/default-handler.ts` | 开箱即用 handler：接 service.streamRun + DraftUpdater |

## 与现有体系的关系

Channel 层和 HTTP `/runs/stream` 是**并行的两条入口路径**：

```
HTTP /runs/stream  → Surface 直调 → service.streamRun
Channel listener   → ChannelDispatcher → defaultHandler → service.streamRun
```

两者共享 interruption scope 机制（`service.ts` 的 `activeScopes`）。

## 使用方式（接入新 IM channel）

```ts
class TelegramChannel implements Channel {
  readonly name = "telegram";
  async start(dispatcher: ChannelDispatcher) {
    bot.on("message", (msg) => {
      dispatcher.enqueue({
        id: msg.id,
        channelName: this.name,
        scopeKey: `telegram:${msg.chatId}`,
        replyTarget: { channelName: this.name, data: { chatId: msg.chatId } },
        text: msg.text,
        threadId: await threadMapper.getOrCreate(msg.chatId),
        timestamp: Date.now(),
      });
    });
  }
  // ... send / draft methods ...
}

// Wire up:
const dispatcher = new ChannelDispatcher();
dispatcher.registerChannel(new TelegramChannel());
dispatcher.setHandler(createDefaultHandler({ service }));
await dispatcher.startAll();
```

## 不包含

- **具体 IM 实现**：Feishu 迁移是下一步
- **debounce / link_enricher / stall_watchdog**：等 channel 跑起来按需加
- **media_pipeline 集成**：由 handler 按需调用，不在 dispatcher 层硬绑
