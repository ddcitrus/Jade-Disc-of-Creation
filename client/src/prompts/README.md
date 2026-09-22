# 提示词目录（公开占位版）

这个目录里装的是「发给 AI 的所有字」。**公开仓库里的这一份是空壳**：导出名齐全、内容为空，
目的是让整套源码仍然能构建、能启动。作者手写的提示词全文不在仓库里。

| 文件 | 原本装的是什么 |
|---|---|
| `protocols.js` | 7 段运行时协议：状态栏、正文语义标记、数值不进散文、修炼结算、战斗推演、战斗接管、战后正文 |
| `storyPresets.js` | 默认正文预设（14 段）、5 种文风、状态写入规则 |
| `contracts.js` | 服从度最高的末尾硬约束：输出形态、主角心理留白、篇幅、视点、首遇建档 |
| `evolution.js` | 正文之后的存档演化契约与字段说明 |
| `assistant.js` | 天道助手、生平压缩、叙事记忆整理、回合摘要 |
| `templates.js` | 交给 AI 照抄的新角色完整快照模板 |
| `tokens.js` | 占位符对照表、预设段落角色表（设置页下拉框读它） |

**为什么空壳也要保留导出名**：`client/src` 下 6 个模块 import 这个目录
（`engine/promptSystem.js`、`engine/evolutionPrompt.js`、`data/mortalProtocols.js`、
`data/snapshotV2.js`、`data/battleTrigger.js`、`pages/GameDashboard.jsx`），
少一个导出名，引用方拿到 `undefined`，构建能过但运行时报错。

需要完整能力时，向作者索取完整版覆盖回这些文件即可，不用改任何代码。
