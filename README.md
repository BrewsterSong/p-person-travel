# Here & Go

一个为 **“不想提前做攻略的人”** 设计的 AI 即时旅行助手。

这个项目不是传统意义上的行程规划工具，而是一个面向真实出行场景的 **即时决策产品**：

用户只需要告诉系统：

- 我现在在哪
- 我现在想做什么

系统就会立刻推荐 **附近可以去的地方**，并把推荐结果与地图联动展示。

---

## Live Demo

https://www.hereandgo.com

---

## Screenshot

<img width="1603" height="955" alt="image" src="https://github.com/user-attachments/assets/ec06498e-e342-47d3-ab62-fa81516b418d" />
<img width="1600" height="953" alt="image" src="https://github.com/user-attachments/assets/18eb4435-1c49-4bf1-a3e6-78513da1164f" />

---

# 一、项目背景

大部分旅游产品都默认用户是 **“J 人”**：

- 出发前做大量攻略
- 提前查餐厅、景点、路线
- 比较不同方案再决定去哪

但真实旅行中，有另一类典型的用户（比如我）：

- 到了再想
- 走到哪算哪
- 不想在多个 App 之间来回查信息

他们真正需要的是：

> “我现在在这里，有什么值得去的地方？”

这个项目就是针对这类用户设计的。

我把它定义为一个 **给 P 人使用的旅行助手**。

核心不是 **规划行程**，而是 **即时推荐**。

---

# 二、核心功能

## 1. 基于当前位置的即时推荐

支持两种位置来源：

- 浏览器定位
- 用户输入地标，例如 `涩谷站`、`东京塔`

系统会结合 **位置 + 用户需求** 生成附近推荐。

---

## 2. 聊天式输入

用户可以直接输入自然语言，例如：

我在涩谷站附近，想吃烧肉
我刚到新宿，找个咖啡店坐一下
我在东京塔附近，想顺路逛个展


系统会解析：

- 位置
- 行为意图
- 推荐类型

---

## 3. 推荐卡片 + 地图联动

推荐结果以结构化卡片展示：

- 店名
- 距离
- 营业状态
- 评分
- 推荐理由

同时地图会显示对应 marker，并支持 hover 联动。

---

## 4. 换一批

用户不满意当前结果时，可以直接：换一批

系统会生成新的推荐批次，而不是重新发起完整搜索。

---

## 5. 追加条件

支持在当前推荐基础上继续收窄，例如：

更近一点
更安静
预算更低
想坐露台


系统会继承上一轮的搜索上下文。

---

## 6. 店铺详情页

详情页支持展示：

- 地址
- 营业时间
- 路线预览
- AI 评价速览
- 近期评论
- 打开 Google Maps

---

# 三、系统架构

整体架构如下：
User
↓
Next.js UI
↓
API Route (/api/chat)
↓
LLM 意图解析
↓
Google Maps / Places
↓
结果排序 + 过滤
↓
地图展示
LLM 主要负责：

- 用户意图解析
- 搜索词转换
- 推荐理由生成

实际的 **地点搜索、排序、过滤、状态管理** 由工程逻辑控制。

---

# 四、技术栈

## Frontend

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4

## Backend

- Next.js Route Handlers

## 地图服务

- Google Maps JavaScript API
- Google Places API
- Google Geocoding API

## AI

- SiliconFlow LLM API

## Deployment

- Vercel

---

## 关键工程问题

### 1. 意图识别：规则优先 + LLM 兜底

旅行场景中存在大量高频、结构化的需求，例如：

咖啡店、酒吧、西餐、酒店、买手店、美术馆等。

如果所有请求都交给 LLM 解析，会导致：

- 响应延迟增加
- 成本上升
- 结果稳定性下降

因此项目采用 **规则优先 + LLM 兜底** 的策略：

第一层：高频关键词映射  
例如：

- 咖啡 → cafe  
- 酒吧 → bar  
- 西餐 → western restaurant  
- 酒店 → hotel  

直接转换为 Places Text Search 查询。

第二层：自然语言解析  
对于长尾表达（例如“找个晚上能坐一下的地方”），再交给 LLM 做语义解析。

这样既保证了效率，也保留了自然语言表达的灵活性。

---

### 2. 多层缓存设计

AI推荐流程中存在多个高延迟、高成本节点，例如：

- 意图解析
- Google Places 查询
- LLM 推荐文案生成
- 评论摘要

项目采用多层缓存策略：

- 意图解析缓存  
- 地点搜索缓存  
- 推荐文案缓存  
- 评论摘要缓存  

通过缓存重复请求的结果，减少 LLM 调用和地图 API 请求，同时显著提升响应速度。

---

### 3. 地理语义误判（东京塔案例）

自然语言查询中常出现 **位置上下文与推荐目标混淆** 的问题。

例如用户输入：

“我在东京塔边上，有没有商场可以逛？”

如果直接把“东京塔”作为搜索目标，系统可能返回：

- 东京塔
- 晴空塔
- 其他景点

而不是商场。

为了解决这一问题，系统对查询做了额外处理：

- 将地标识别为 **位置上下文**  
- 将“商场 / 购物”等提取为 **搜索目标类型**  
- 对候选结果进行 **类型过滤和距离约束**

从而避免推荐结果跑偏。

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 创建 `.env.local` 并配置环境变量

```env
SILICONFLOW_API_KEY=
GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
SERPAPI_KEY=
```

说明：

- `SERPAPI_KEY`：SerpApi 的 API Key，用于通过 Google `site:reddit.com` 做 Reddit 内容发现。

3. 启动开发服务器

```bash
npm run dev
```

浏览器访问：

http://localhost:3000

## Reddit 旅行讨论 Demo

本项目新增了一套最小可用的 Reddit 旅行讨论接入：

- `GET /api/reddit/search?query=Kyoto%20itinerary`
- `GET /api/reddit/detail?url=https://www.reddit.com/r/...`
- `GET /api/reddit/comments?url=https://www.reddit.com/r/...&limit=3`

聊天里也支持直接触发讨论卡，例如：

- `Bangkok`
- `Shibuya`
- `Kyoto itinerary`
- `where to stay in Osaka`

然后执行：

```bash
npm test
```

可验证 Reddit 发现层 query builder 与 discussion 映射的最小测试。
