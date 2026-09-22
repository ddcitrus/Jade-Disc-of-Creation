# 战场 3D 模型（第三方素材，全部 CC0）

本目录下的模型**不是本项目原创**，均来自公开发布的 CC0（公有领域）素材包，
可商用、可修改、无需署名。这里保留来源与授权说明，方便日后核对与替换。

## 1. Kenney · Nature Kit（330 个资产，CC0）

- 来源：https://kenney.nl/assets/nature-kit
- 授权：CC0 1.0（见包内 `License.txt`；https://creativecommons.org/publicdomain/zero/1.0/）
- 取用格式：`Models/GLTF format/*.glb`
- 用途：山体（崖块/巨岩/立石）、树木、草丛、花草、蘑菇、睡莲、水面砖、石雕

## 2. Kenney · Mini Characters（26 个资产，CC0）

- 来源：https://kenney.nl/assets/mini-characters
- 授权：CC0 1.0
- 取用格式：`Models/GLB format/character-*.glb` + `Models/GLB format/Textures/colormap.png`
- 用途：战场上的角色。模型自带骨骼与 32 段动画，
  本项目用到 `idle` / `walk` / `attack-melee-right` / `attack-melee-left` / `die` / `crouch` / `sit`。
- ⚠️ 贴图是**外链**（GLB 内写的是相对路径 `Textures/colormap.png`），
  所以 `characters/Textures/` 必须与 glb 一起保留，不能只拷 glb。

## 3. Poly Haven · 贴图（3 张，CC0）

- 来源：https://polyhaven.com/ （CC0 许可说明 https://polyhaven.com/license）
- 文件：`client/public/tex/dirt_floor.jpg`、`grass_ground.jpg`、`gray_rocks.jpg`
- 用途：地块表面与沙盘侧壁的贴图（本轮之前就在用）

---

## 体积

- nature 模型：单个 2~40 KB，全部加起来不到 400 KB
- 角色：单个约 240~270 KB（含骨骼与 32 段动画），按需加载
- 贴图：3 张共约 2.7 MB（已压缩过）

## 想换素材怎么办

`client/src/data/battleSceneModels.js` 是**唯一的映射表**：
哪一格摆什么、用哪个 glb、缩放多少、朝向怎么定，全写在那里。
换模型只需换文件名；新增地形种类时忘了配模型也不会报错，会退回「不摆装饰」。
