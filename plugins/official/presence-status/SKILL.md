# presence-status —— 按「自己是否在游戏内」自动切换自定义状态描述

> 本文档给调用本插件的 AI Agent 看：这个插件能做什么、怎么用。

## 为什么需要它

本服务常驻登录 VRChat 账号（云服务器 24h 在线）时，自己在好友眼里长期是
**"在网站上活跃"**（位置 `offline:offline`）。使用者希望一眼能区分两种情况：

- **在游戏内**（自己在 VRChat 客户端里）→ 一套状态文案
- **只在网页端在线 / 挂机**（人不在游戏，服务还挂着）→ 另一套状态文案

核心的动态状态引擎（`get_dynamic_status` / `set_dynamic_status`）只支持
`{online}`（在线好友数）一个变量，无法区分上面两种情况；本插件补上这个能力。

## 能力

- **get_presence_status**：查询配置、当前自我在场判定（`in_game` / `not_in_game` / `unknown`）、
  最近一次成功写入的文案与时间、最近错误。
- **set_presence_status**：设置开关、两套文案、轮询间隔；可 `syncNow` 立即同步一次。

配置项（存在插件私有表，跨重启保留）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用自动切换（默认关闭，需显式开启） |
| `inGameTemplate` | `在玩 VRChat，可能看不到消息` | 在游戏内时写入的自定义状态文字（≤64 字符） |
| `idleTemplate` | `挂机中（服务在线）` | 只在网页端在线时写入的自定义状态文字（≤64 字符） |
| `pollSeconds` | `60` | 轮询间隔秒（下限 20，上限 3600） |

## 用法

Agent 直接通过 MCP `tools/call` 调用，例如：

```
set_presence_status { "enabled": true,
                      "inGameTemplate": "在玩 VRChat，可能看不到消息",
                      "idleTemplate": "挂机中（服务在线）" }
get_presence_status
```

返回（`get_presence_status` 节选）：

```json
{
  "config": { "enabled": true, "inGameTemplate": "…", "idleTemplate": "…", "pollSeconds": 60 },
  "presence": { "state": "not_in_game", "location": "offline:offline", "at": "2026-09-17T10:00:13.422Z" },
  "lastText": "挂机中（服务在线）",
  "serviceAvailable": true
}
```

## 行为与不变量

- **只改自定义状态文字**（`statusDescription`），`status` 种类原样回传，**不改变在线形态**。
- **不确定就不动**：核心自我在场判定返回 `unknown`（无记录 / 位置陈旧超 1 小时 / 解析失败）时，
  本插件**不翻转现状**，保持上一次写入的文案。
- **防抖**：两次 PUT 之间最小间隔 65 秒（与核心动态状态引擎同阈值）；文案未变化不提交；
  重启后从插件表恢复"最近写入文案"，不会因重启重复提交。
- **写前核对**：PUT 之前先读 `/auth/user`，若当前文案已等于目标值则只记基线不重复提交
  （使用者在别处手动改过同样文案时不会互相覆盖成抖动）。
- **延迟**：插件契约 v1.3 的 8 个 API 面没有事件订阅能力，因此按 `pollSeconds` 轮询
  （默认 60s）——**从你进/出游戏到文案切换，最坏延迟约等于轮询间隔**。轮询本身只查本地
  SQL（不产生 VRChat API 调用），只有文案真正需要变化时才发生 `/auth/user` + `PUT /users/{id}`。

## 依赖

- 核心服务 `dashboard.selfPresence`（三态自我在场判定，见 `core/self-presence.js`）；
  缺该服务时工具仍可查询配置，但同步动作会返回 `reason: "no-self-presence-service"`。
