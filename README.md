# 造化玉碟 · 独立版

一个跑在自己电脑上的修仙文字世界：你在网页里输入行动，AI 负责把接下来的剧情写出来，
遇到打斗时会切进 3D 战棋回合制。

**所有东西都在你本地** —— 存档、设置、你填的 API 密钥，一个都不会上传到任何地方。
AI 那部分需要你自己准备一个接口（进游戏第一件事就是配它，见第三节）。

---

## 一、开始之前

你需要装一样东西：**Node.js**（版本 18 以上，推荐 20 或更新）。

去 <https://nodejs.org/> 下 LTS 版，一路下一步装完就行。装完可以开个命令行敲
`node -v` 确认一下，能打印出版本号就成。

除此之外不需要装数据库、不需要 Docker、不需要联网下载游戏资源。

---

## 二、怎么拿到、怎么启动

### 拿到项目

```bash
git clone git@github.com:ddcitrus/Jade-Disc-of-Creation.git
```



### 第一次启动

双击项目根目录的 **`启动游戏-网页版.bat`**。

它会自己做四件事，第一次会慢一些（要下载依赖 + 构建前端，大概一两分钟）：

1. 缺依赖就自动 `npm install`（前后端各一次）
2. 构建前端（`vite build`）
3. 杀掉端口 8346 上残留的旧后端
4. 打开浏览器并启动服务

窗口里出现 `backend: http://127.0.0.1:8346` 就说明起来了。
**这个黑窗口要一直开着**，关掉游戏就停了。

### 之后每次

还是双击同一个 `启动游戏-网页版.bat`。它会重新构建一次前端再启动 —— 所以只要你改过代码，双击一次就生效。

### 不用 bat 的话

在项目根目录：

```bash
npm run install:all   # 装依赖（只需一次）
npm run build         # 构建前端
npm start             # 启动服务，然后浏览器打开 http://127.0.0.1:8346
```

### 开发时热更新

改前端代码想即时预览，别用 `npm start`（它跑的是构建好的产物），用这个：

```bash
npm run dev:server    # 一个窗口：后端，跑在 8346
npm run dev:client    # 另一个窗口：前端，vite 跑在 5173，改代码即时生效
```

打开 `http://127.0.0.1:5173` 就是开发版。**两个窗口都要开着** ——
vite 会把 `/api` 的请求转发给 8346 的后端，后端没起就会一片报错。

---

## 三、第一次进游戏必须先做的事

**先去配 AI 接口，否则点了「开始新人生」也写不出正文。**

启动页有三项：`开始新人生` / `读取人生` / `系统设置`，还有右下角一个 `纸色` 开关
（`玄墨` 是深色，`宣纸` 是浅色）。

进 **系统设置 → 接口库**，新增一条：

| 要填的 | 说明 |
| --- | --- |
| 名称 | 随便起，比如「我的接口」 |
| 接口地址 | OpenAI 兼容的 `baseUrl`，例如 `https://api.xxx.com/v1` |
| 密钥 | 你的 API Key |
| 模型 | 模型名，例如 `gpt-4o`、`deepseek-chat` 等 |

填完在 **通道选择** 里指定：正文通道用哪条、快照通道用哪条（快照留空就跟着正文走）。

> 走的是标准 OpenAI 兼容协议，所以任何兼容这个协议的服务都能用。

配好之后回到启动页点 **开始新人生**，按引导建角色（姓名、性别、灵根、出身、性格等），
建完就进主界面了。

---

## 四、游戏里有哪些页面

左侧竖排导航，一共 12 项：

| 页面 | 干什么 |
| --- | --- |
| **故事** | 主界面。上方是剧情正文，下方输入框写你的行动，右侧是人物信息栏 |
| **剧情演化** | 看／改「剧情演化预设」——正文写完之后，AI 靠它把正文里的变化落成存档改动 |
| **存档修改** | 直接看和改存档里的角色数值 |
| **世界因子** | 世界因子库，用来给世界加设定；所有存档共用 |
| **世界书** | 世界设定条目；**所有存档共用一份**，存在 `server/data/worldbook.json` |
| **查看人物** | 不是独立页，点开是右侧滑出的角色卡面板 |
| **天道助手** | 手动问 AI 问题，或者让它帮你改存档 |
| **快照** | 状态存点。每隔若干回合自动存一次，也可以手动存；能回退到任意一个存点 |
| **地图** | 当前世界地图 |
| **数值表** | 境界属性区间表，决定 AI 生成角色的数值范围 |
| **其它约束** | 额外的写作约束（比设置页里的那些更长、更自由） |
| **设置** | 接口库、篇幅字数、文风、人称、字体、战斗模式、预设导入等 |

### 一次「回合」会发生什么

1. 你在输入框写行动，回车
2. 程序把状态、最近剧情、世界书、规则等拼成一条请求发给 AI
3. AI 返回正文（几十秒，看模型速度）
4. **正文写完后自动再跑一次「演化」**，让 AI 把正文里的变化（升级、受伤、得到物品……）
   落成结构化的存档改动，程序校验后写进存档
5. 如果这一回合里触发了战斗，会切进 3D 战棋界面，打完再补写一段正文

战斗模式在 **设置 → 战斗模式** 里切换。

---

## 五、想改东西，改哪里

| 你想改的 | 去哪改 |
| --- | --- |
| AI 的说话方式、写作规则、输出格式 | **设置页**（推荐）或 `client/src/prompts/` 里的文件 |
| 世界设定 | 游戏里 → **世界书** 页；或直接编辑 `server/data/worldbook.json` |
| 数值区间（境界属性范围） | 游戏里 → **数值表** 页 |
| 界面主题、字体、行距 | **设置** 页 或 启动页的 `纸色` 开关 |
| 战斗规则数值 | `client/src/data/` 下的战斗相关文件（改完要重新构建） |

**改提示词请先读 [`client/src/prompts/README.md`](client/src/prompts/README.md)** —— 那里把
「哪一句在哪个文件、改了什么时候生效」讲得很细。

一句话概括：`client/src/prompts/` 里装的是**出厂默认**，你在设置页配过的那份**优先**。

---

## 六、文件分布

### 根目录

```
jade-disc-of-creation/
├── README.md                 ← 你正在看的这份
├── .gitignore                哪些东西不传 GitHub（写得很详细，值得一读）
├── package.json              上游快捷命令：install:all / build / start / dev:*
├── 启动游戏-网页版.bat        唯一的启动入口，双击它
├── client/                   前端（React + Vite + three.js）
└── server/                   后端（Express），同时负责托管前端构建产物
```

### `client/` —— 前端

```
client/
├── index.html                网页外壳
├── vite.config.js            构建配置
├── package.json              dev / build / test:* 三条脚本都在这里
├── public/                   ── 静态资源（构建时原样拷进 dist）
│   ├── models/               3D 素材，占了仓库 99% 的体积
│   │   ├── README.md             素材来源与授权说明
│   │   ├── anim/                 18 个动作 FBX（跑、跳、攻击、受击……）
│   │   ├── characters/           12 个低模角色 glb + 共用贴图
│   │   ├── nature/               272 个自然物件（树、石、草、崖……）
│   │   └── vrm/                  18 个 VRM 人物模型
│   └── tex/                  3 张地面贴图
├── dist/                     构建产物（gitignore，由 npm run build 生成）
└── src/                      ── 源码
    ├── main.jsx / App.jsx        入口与顶层路由
    ├── api.js                    所有跟后端说话的封装都在这
    ├── saveModel.js              存档结构、迁移、自愈、快照存取
    ├── theme.js / fontPrefs.js   主题与字体偏好
    ├── ui.jsx                    通用小组件（提示条、转圈）
    ├── theme.css                 设计系统（配色令牌、组件基础样式）
    ├── polish.css                细节打磨层
    ├── guigu.css                 换肤层（鬼谷八荒风）
    ├── guigu-fx.css              动效层
    │
    ├── components/           界面零件
    │   ├── StoryRenderer.jsx     正文渲染（语义标记、选项、状态栏都在这解析）
    │   ├── PersonalityDims.jsx   性格维度条
    │   └── ModTags.jsx           标签
    │
    ├── data/                 游戏数据与规则（这一层放的是"规则和数值"，不是"文案"）
    │   ├── gameData.js                 境界、灵根、出身、物品等基础数据
    │   ├── numericTuning.js            数值表生效值的取用逻辑
    │   ├── mortal-numeric-tuning.json  数值表的**出厂底稿**
    │   ├── realmBounds.js / attrClamp.js   属性边界与校界
    │   ├── mortalProtocols.js          运行时协议「怎么拼」（文字原文在 prompts/）
    │   ├── battleEngine.js / battleGrid.js / battleMapGen.js / battleAI.js
    │   ├── battleTrigger.js / battleBeats.js / battleTerrain.js / battleUnits.js
    │   ├── battleSceneModels.js / battleDice.js / battleSpeed.js
    │   │                               ↑ 战斗系统：算账、地图、AI、节拍、模型映射
    │   ├── snapshotV2.js / snapshotSchema.js   快照模板与校验
    │   ├── evolutionV2Envelope.js       演化结果的信封格式
    │   ├── traitLibrary.js / skillCodex.js     特质库、功法库
    │   ├── cultivationParams.js         修炼参数
    │   ├── colorPalette.js / gradeUtils.js     着色词表、品阶换算
    │   ├── apiEndpoints.js              接口库的数据结构
    │   └── saveSanitize.js              存档落盘前的清理
    │
    ├── engine/               拼装与解析
    │   ├── promptSystem.js       ★ 正文那一整条请求怎么拼
    │   ├── evolutionPrompt.js    ★ 演化请求怎么拼
    │   ├── mortalCommands.js     游戏指令的解析与执行
    │   ├── narrative.js          开局旁白、回合旁白
    │   ├── promptLayout.js       提示词注入顺序
    │   ├── placeholderExtractor.js  占位符提取
    │   ├── stMacroEngine.js      SillyTavern 风格宏（{{random::}} 等）
    │   ├── worldTime.js          游戏内时间
    │   └── dragAutoScroll.js     拖动自动滚动
    │
    ├── pages/                各个页面
    │   ├── Splash.jsx            启动页
    │   ├── CreateWizard.jsx      新建角色向导
    │   ├── GameDashboard.jsx     ★ 主界面骨架（侧栏导航就在这）
    │   ├── GamePages.jsx         故事页、演化页、世界书页、存档页、因子页
    │   ├── ExtraPages.jsx        快照页、地图页、角色详情
    │   ├── CharacterPanel.jsx    右侧角色卡滑出面板
    │   ├── CharacterDetail.jsx   单个角色详情
    │   ├── NumericPage.jsx       数值表页
    │   ├── ConstraintsPage.jsx   其它约束页
    │   ├── SavesPage.jsx         存档列表
    │   ├── SettingsPage.jsx      ★ 设置页（接口、篇幅、文风、预设导入……）
    │   ├── BattleView.jsx        战斗界面（面板层）
    │   └── BattleScene3D.jsx     战斗界面（three.js 三维战场）
    │
    ├── prompts/               ★★ 发给 AI 的所有文字都在这里，先读它的 README
    │   ├── README.md             说明：每个文件装什么、怎么改、哪些不在里面
    │   ├── protocols.js          7 段运行时协议
    │   ├── storyPresets.js       默认正文预设、文风
    │   ├── contracts.js          末尾硬约束（篇幅、视点、输出形态……）
    │   ├── evolution.js          演化契约与默认规则
    │   ├── assistant.js          天道助手、生平压缩、记忆整理、摘要
    │   ├── templates.js          新角色快照模板
    │   └── tokens.js             占位符对照表
    │
    ├── three/                三维相关
    │   ├── loadVrm.js / vrmAnimator.js / mixamoRig.js      模型加载与动作
    │   └── buildWater.js / buildPostFX.js / procNature.js  水面、后处理、植被
    │
    └── _unused/              隔离区（不在版本库里，见下）
```

### `server/` —— 后端

```
server/
├── index.js                 整个后端就这一个文件。所有 API、存档读写、静态托管都在这
├── aiUsage.js               统计 AI 调用的用量
├── package.json / package-lock.json
└── data/                    ★ 你的全部进度都在这里（不进版本库，见第七节）
    ├── settings.json            设置 + 你的预设 + API 密钥 + 数值表改动
    ├── worldbook.json           世界书（所有存档共用）
    ├── factor-library.json      世界因子库（所有存档共用）
    ├── ai-stats.json            AI 用量统计
    ├── ai-debug.log             AI 调试日志（AI 不回话时先看这个）
    ├── saves/                   存档本体
    │   └── save_xxxx.json          一个文件 = 一个人生
    ├── snapshots/               剧情快照（回退用）
    │   └── save_xxxx/              每个存档一个子目录
    └── char_snaps/              角色独立快照
```

> `server/data/` 这个位置不是写死的，可以用环境变量 `FANREN_DATA_DIR` 指到别处
> （桌面版就是这么做的）。同理 `PORT` / `HOST` 也可以覆盖，默认 `127.0.0.1:8346`。

### `client/_unused/` —— 隔离区

一个集中收纳「**删了也照样能玩**」的东西的目录。**它不在版本库里**（`.gitignore` 排除），
所以从 GitHub clone 下来是没有这个目录的。

里面大致是：旧的开发文档、一次性工具脚本、桌面版打包壳、原始模型素材副本、
开发期用的探针工作区、生成出来的提示词清单等。
清单与恢复办法见目录内的 `README-隔离说明.md`。

**注意它必须待在 `client/` 下面，不能挪到项目根。** 因为里面有约 75 个文件靠
「从自己位置往上两级 = client」来定位项目，换个深度就全部失效。

跑测试的命令还用到其中两套：`_unused/battletest/`（战斗回归）、
`_unused/scene3d/`（界面与端到端回归）—— 见第八节。

---

## 七、开发者常用命令

在 `client/` 目录下：

| 命令 | 干什么 | 结果 | 耗时（实测） |
| --- | --- | --- | --- |
| `npm run build` | 生产构建 | 126 个模块 | ≈8 秒 |
| `npm run test:battle` | 战斗系统回归，14 组共 194 项 | 193 过 / 1 过不了 | ≈6 秒 |
| `npm run test:ui` | 界面回归，33 项 | 全过 | ≈25 秒 |
| `npm run test:e2e` | 端到端回归，51 项 | 全过 | ≈26 秒 |
| `npm run test:all` | 上面三套连着跑 | — | ≈57 秒 |

### ⚠ 后两套跑之前必须先重建探针

```bash
node _unused/scene3d/build.cjs
```

`vite build`（以及启动脚本里的那一步）会清掉 `client/dist/probe*`，
而 `test:ui` / `test:e2e` 要靠这些探针页面跑。不重建就会崩在
`SyntaxError: "undefined" is not valid JSON`。

**所以顺序是：先 `npm run build`，再 `build.cjs`，最后跑测试。**
`test:battle` 不依赖探针，随时可跑。

### 已知的固定失败项

`test:battle` 里有一项 **「障碍绕行」**稳定失败 —— AI 寻路最近只走到 6 步，断言要求 ≤2。
这是记录在案的老问题，不是新引入的回归。

另外 `test:battle` 因为有这 1 项失败，进程退出码是 **1**（正常现象，不是崩溃）。

### 关于体积

仓库里已跟踪文件合计约 **452 MB**，其中 `client/public/models/` 占 **447.5 MB**：

| 目录 | 文件数 | 体积 |
| --- | --- | --- |
| `models/vrm/` | 18 | 331.2 MB |
| `models/nature/` | 272 | 98.8 MB |
| `models/anim/` | 18 | 14.5 MB |
| `models/characters/` | 13 | 2.9 MB |

想瘦身：`.gitignore` 末尾有现成开关，取消注释即可把仓库降到约 10 MB，
代价是别人 clone 后 3D 战场没有模型（**文字玩法完全不受影响**）。

---

## 八、素材来源与授权

- `models/nature/`、`models/characters/`、`tex/` 来自 **Kenney** 与 **Poly Haven**，
  均为 **CC0（公有领域）**，可商用、可修改、无需署名。明细见
  [`client/public/models/README.md`](client/public/models/README.md)。
- `models/anim/` 与 `models/vrm/` 的再分发许可**未在本项目中声明**。
  VRM 文件名是 pixiv 风格编号，公开分发前请自行确认每个模型的授权。

---

## 九、常见问题

**Q：提示「未检测到 client/dist，仅提供 API」**
前端还没构建。跑一次 `npm run build`（或直接双击 `启动游戏-网页版.bat`）。

**Q：页面能打开但一直是转圈 / 正文写不出来**
先去 **设置 → 接口库** 确认地址、密钥、模型都填了，并在「通道选择」里选中了它。
还不行就读 `server/data/ai-debug.log`（里面的时间戳是 UTC，+8 小时才是本地时间）。

**Q：改了 `client/src/prompts/` 里的文字，游戏里没变化**
多半是你在设置页里配过同一项 —— **设置页那份优先**。去设置页恢复默认，或者干脆改设置页里的那份。

**Q：改了代码但界面没变**
需要重新构建。双击一次 `启动游戏-网页版.bat` 它就会自动重建；或者手动 `npm run build`。

**Q：只想改世界书/数值表，不想开游戏**
世界书可以直接用记事本编辑 `server/data/worldbook.json`，改完刷新一下游戏页面就认。
数值表建议在游戏里的「数值表」页改 —— 那个会即时写回文件，而且不会填错格式。

**Q：端口 8346 被占了**
`启动游戏-网页版.bat` 会自动杀掉占用它的旧后端。想换端口就在启动前设环境变量 `PORT`。

**Q：游戏卡 / 一个回合等很久**
慢的是 AI 那一步（正文 + 演化各一次请求），跟本机性能无关。正文输出上限在
**设置 → 正文输出上限**，换更快的模型通常比调参数有效。
