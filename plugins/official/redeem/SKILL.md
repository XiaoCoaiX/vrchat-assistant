# redeem —— VRChat 兑换码与礼包领取

> 本文档给调用本插件的 AI Agent 看：这个插件能做什么、怎么用。

## 为什么需要它

VRChat 的免费物品（活动/联名/周年/直播掉落，中文社区戏称「**免费鸡蛋**」）走的是
一条四段式链路，缺任何一步都拿不到东西：

```
兑换码 ──redeem_code──▶ 礼包(bundle) ──claim_bundle──▶ 库存物品
        POST /reward/redeem      POST /inventory/{id}/consume
```

在此之前 Agent 只能手搓 curl 打 REST，还要记住一串易错细节（`Cookie: auth=<值>`
前缀、必带 User-Agent、`/inventory?types=bundle` 才是礼包列表、consume 才是领取），
既不可复用也不可验证。本插件把这条链路固化为 MCP 工具。

核心既有工具的关系：`get_inventory_global`（账号级全局物品）与 `get_inventory_drops`
（掉落）**都不覆盖兑换码与礼包**——那是 inventory 域的另一套端点，本插件补上这一段。

## 能力

| 工具 | 作用 | 对应 VRChat 端点 |
|---|---|---|
| `redeem_code` | 提交兑换码（一次性，不可回滚） | `POST /reward/redeem` |
| `get_redeemable_bundles` | 列出**待领取**的礼包（含过期时间） | `GET /inventory?types=bundle` |
| `claim_bundle` | 领取（打开）礼包，内容物进库存 | `POST /inventory/{id}/consume` |
| `get_inventory_items` | 列库存物品（可按 itemType 过滤） | `GET /inventory` |
| `get_redeem_history` | 本机兑换/领取历史（插件私有表） | 本地表 `plg_redeem_history` |

## 典型工作流

**领一个码：**

```
1. redeem_code { "code": "R0614WS81RYC0EUY" }
   → { ok:true, count:1, items:[{ inventoryId:"invt_...", name:"Tokyo Game Show 2026 Nameplate", itemType:"bundle", contains:1 }],
       nextStep:"本次含礼包：请用 get_redeemable_bundles 查看，再 claim_bundle 领取礼包内容" }
2. get_redeemable_bundles
   → { ok:true, count:1, items:[{ inventoryId:"inv_4f884e92-...", name:"Tokyo Game Show 2026 Nameplate", expiryDate:null }] }
3. claim_bundle { "inventoryId": "inv_4f884e92-..." }
   → { ok:true, count:1, items:[{ name:"Bolt Matrix", itemType:"nameplateEffect", description:"Pure pop energy." }] }
4. get_inventory_items { "type": "nameplateEffect" }   # 核对到账
```

**只查不收：**

```
get_redeemable_bundles          # 有没有待领礼包（VRC+ 掉落、活动礼包都在这）
get_inventory_items { "type": "bundle" }
get_redeem_history { "limit": 10, "kind": "redeem" }
```

## 不变量与注意事项

- **兑换码是一次性消耗品**：`redeem_code` 成功即不可回滚（VRChat 侧原子）；失败不会改动账号任何状态。
- **礼包必须再领一次**：`redeem_code` 返回的 `itemType: "bundle"`（或 `contains > 0`）表示还需要
  `claim_bundle`；领取后该礼包从 `?types=bundle` 列表消失，**不可重复领取**。
- **礼包图标是通用宝箱图**，不代表内容物——要知道里面是什么只有 `claim_bundle` 返回的
  `items[].name` 说了算，别拿图标或活动名反推。
- **失败如实返回**：`{ ok:false, status, error }`（码失效/已用/拼错都会失败），绝不假装成功。
- **不接触凭据**：所有出网请求走 `api.vrchat.fetch`（核心注入登录态 + 自动限流）；
  历史表只存码/物品名/响应摘要，**不落 cookie/token**。
- 读取不到东西时先怀疑限流与登录态：`get_server_status` 看 `auth.authenticated` 与 `ws.status`。

## 依赖

- 无插件依赖（`depends: []`）。
- 需要核心的 VRChat 登录态：未登录时工具返回 `status: 401`（`Missing Credentials`），
  先恢复登录再重试。
