# 单机阿瓦隆

一个人在浏览器里玩《抵抗组织：阿瓦隆》（The Resistance: Avalon）。你坐在 1 号位，其余 4–9 个座位由 AI 骑士入座。AI 会推理、投票、栽赃、出失败票、刺杀梅林。

不需要联网，不需要安装任何依赖，也不需要 API Key。

## 开始游戏

- **直接双击 `index.html`**，用任意现代浏览器打开即可。
- 想要一个可以随手拷走的单文件版本：`node scripts/build.js`，生成 `dist/avalon.html`（约 90 KB）。

界面字体来自 Google Fonts。断网时会自动退回系统自带的宋体/黑体，不影响游戏。

## 功能

- 5–10 人局，完整规则：组队、公开投票、连续五次否决判负、秘密任务牌、7 人以上第四个任务需要两张失败票、刺杀梅林。
- 角色：梅林、派西维尔、亚瑟的忠臣、刺客、莫甘娜、莫德雷德、奥伯伦、莫德雷德的爪牙。可以自由勾选，也可以指定自己的角色。
- 湖中仙女：第二、三、四个任务后查验阵营，持有者可以如实公布、说谎或沉默。
- 圆桌讨论：每次任务后大家依次发言，可以怀疑或信任某人。AI 会听你的话，也会互相附和、栽赃。
- 编年史与投票记录表：完整记录每次组队、每张票和每次任务结果，方便复盘推理。
- 三档 AI 水平（新手 / 熟练 / 老练），三档节奏。
- 适配手机与桌面，支持浅色和深色模式。

## AI 是怎么想的

每个 AI 都会枚举"哪几个人是坏人"的全部可能（10 人局最多 C(10,4)=210 种），并结合自己的夜晚情报排除不可能的组合，然后根据公开信息做贝叶斯更新：

| 证据 | 更新方式 |
| --- | --- |
| 任务结果 | 出现 k 张失败票说明队里至少有 k 个坏人（硬约束），全成功的队伍也会降低嫌疑（坏人可能藏票，所以是软约束） |
| 投票 | 坏人倾向赞成有坏人的队伍、反对干净的队伍；第五次组队时好人必须赞成，此时投反对票嫌疑极大 |
| 组队 | 队长倾向带上自己信任的人 |
| 发言 | 好人的怀疑略微可信，坏人的怀疑多半是栽赃 |
| 湖中仙女声明 | 好人如实公布，坏人可能说谎 |

在此基础上按角色行动：

- **好人**选择"干净概率"最高的队伍；当提议的队伍明显不如最优选择时投反对。
- **梅林**把真实情报和"普通好人能推出来的结论"混在一起用，偶尔放行坏人的队伍来隐藏自己；发言时只点名那些普通好人也能怀疑到的坏人。
- **坏人**用"旁观者视角"判断谁看起来可信，组队时只放一个坏人、其余挑最被信任的好人；投票时有一定概率模仿好人；多个坏人同队时约定只由一人出失败票；第一、二轮可能藏票以骗取信任。
- **刺客**根据每个人的组队、投票和发言计算"这个人是否知道得太多"，挑出最像梅林的人。

AI 只能读取自己视角的信息（`game.viewFor(id)` 与自己可见的事件），不会偷看身份。

### 平衡性

`node scripts/simulate.js 500 normal` 让 AI 互相对战，"熟练"难度下好人胜率大致在 44%–61%（不同人数有差异），坏人的胜利大多来自刺杀梅林：

| 人数 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- |
| 好人胜率 | 60% | 61% | 57% | 56% | 59% | 44% |

## 项目结构

```
index.html          页面
css/style.css       样式（浅色/深色主题）
js/rules.js         规则常量：人数、任务人数、角色与配置校验
js/engine.js        游戏引擎：纯状态机，带种子随机数，按玩家视角过滤信息
js/ai.js            AI：信念模型、角色策略、对局驱动
js/ui.js            界面与流程控制
scripts/build.js    打包成单个 HTML
scripts/simulate.js AI 对战胜率统计
tests/              规则、引擎与 AI 测试
```

引擎和 AI 不依赖 DOM，可以直接在 Node 中使用：

```js
const { createGame } = require('./js/engine.js');
const AI = require('./js/ai.js');

const game = createGame({ numPlayers: 7, seed: 1 });
AI.playOut(game, AI.createBots(game, { level: 'hard' }));
console.log(game.winner, game.endReason);
```

## 开发

需要 Node.js 18 及以上，无第三方依赖。

```bash
npm test                         # 运行测试
node scripts/simulate.js 500 hard  # AI 对战统计
node scripts/build.js            # 生成 dist/avalon.html
```

## 调研：GitHub 上的类似项目

动手之前查了一圈，现有项目大致分三类，都不是"一个人对战电脑"的单机游戏：

| 项目 | 类型 | 说明 |
| --- | --- | --- |
| [jonathanmli/Avalon-LLM](https://github.com/jonathanmli/Avalon-LLM) | 研究 | AvalonBench 基准（Python），包含规则 bot 与 LLM 智能体，用于评测大模型 |
| DeepRole（MIT，NeurIPS 2019 论文 *Finding Friend and Foe in Multi-Agent Games*） | 研究 | CFR + 价值网络，在线对局中胜过人类；论文中的方法 |
| [TokenGnome/Amalon](https://github.com/TokenGnome/Amalon) | 模拟器 | Objective-C 引擎，用 JS 编写 bot 互相对战，没有人类玩法 |
| vck3000/ProAvalon、avalon.ist | 联机平台 | 多人在线对局网站，需要真人凑局 |
| [ldeluigi/avalon](https://github.com/ldeluigi/avalon) | Discord 机器人 | 在 Discord 群里主持游戏 |
| [mlsteele/reactance](https://github.com/mlsteele/reactance) | 辅助工具 | 传手机发身份的小工具 |

本项目参考了 AvalonBench 的"规则 bot + 角色化策略"思路和 DeepRole 的"对所有身份组合做推理"思想，但用轻量的贝叶斯枚举实现，整个游戏可以离线运行在浏览器中。
