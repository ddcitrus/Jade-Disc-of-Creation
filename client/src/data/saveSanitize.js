// 存档脏数据自愈（零依赖）
//
// 为什么单独拆一个模块：服务端也要用同一套修复规则，但服务端 import 不了 saveModel.js
// （那条链上挂了 mortal-numeric-tuning.json，node 直跑会报 ERR_IMPORT_ATTRIBUTE_MISSING）。
// 这里只做纯数据的字段修复，不 import 任何东西，前后端共用同一份实现。
//
// 目前治两类历史 bug：
//   1. 主角姓名被写成角色 ID（B1）—— 初始化时键名不匹配落到兜底值，随后又被回写到 character.name
//   2. bio.longTermGoal 里塞的是「性格底色：…」—— 性格摘要串门到了长期目标

// 角色 ID 形如 B1 / C12 / P_Fox
export function looksLikeCharId(name) {
  const t = String(name ?? '').trim();
  return /^[A-Z]\d+$/.test(t) || /^P_[A-Za-z0-9_]+$/.test(t);
}

// 长期目标被串门写进性格摘要的痕迹
export function isPersonalityLeak(value) {
  return /^性格底色：/.test(String(value ?? '').trim());
}

/**
 * 删掉快照顶层的 `player` 块（2026-09-22 按玩家要求整体废弃）。
 *
 * 这一块曾是「主角专有」的 13 项：善恶值 / 心魔值 / 进度 / 头像外观 / 是否极端 /
 * 死亡次数 / 是否在洞府 / 绿瓶 / 绿瓶剧情编号 / 主角特质 / 叙事人称 / 叙事代词 / 修炼经验进度。
 * 实测其中 8 项全项目零读取，另外 5 项里也只有「修为进度」有实际写入路径 —— 其余四项
 * 除建档初值外没人改，等于永远停在 0 / 不出现。故整体删除。
 *
 * 迁移规则（幂等，绝不改调用方传入以外的对象）：
 *   旧档里 `player.progress` 有非零值时，先搬到 `identity.realmProgress`（与 NPC 同一格）再删块；
 *   两边都有非零值时保留 identity 那份，不覆盖。
 *
 * @returns {boolean} 是否真的清掉了这个块
 */
export function stripPlayerBlockInPlace(snap) {
  if (!snap || typeof snap !== 'object' || !snap.player || typeof snap.player !== 'object') return false;
  const legacy = Number(snap.player.progress);
  const cur = Number(snap.identity?.realmProgress);
  if (Number.isFinite(legacy) && legacy !== 0 && !(Number.isFinite(cur) && cur !== 0)) {
    if (snap.identity && typeof snap.identity === 'object') snap.identity.realmProgress = legacy;
  }
  delete snap.player;
  return true;
}

// 就地修复一份存档；返回被修好的字段列表（空数组 = 本来就是干净的）
export function sanitizeSaveInPlace(save) {
  const fixed = [];
  if (!save || typeof save !== 'object') return fixed;

  // 世界书已改为跨存档共用（server/data/worldbook.json），存档里不再保留该字段。
  // 必须放在最前面：下面遇到缺 charSnapshots 的存档会提前 return，这条不能跟着被跳过。
  // 旧版前端（内存里还留着 worldbook 的 bundle）整份写回时，靠这条保证磁盘不被写脏。
  if (save.worldbook !== undefined) {
    delete save.worldbook;
    fixed.push('worldbook 已删除（世界书改为跨存档共用，见 server/data/worldbook.json）');
  }

  const snaps = save.charSnapshots;
  if (!snaps || typeof snaps !== 'object') return fixed;

  // 可选的真名来源：角色记录 → 存档名；两者都不能是角色 ID
  const pickRealName = (v) => {
    const t = String(v ?? '').trim();
    return t && !looksLikeCharId(t) ? t : '';
  };
  const charRealName = pickRealName(save.character?.name);
  const saveRealName = pickRealName(save.name);
  const npcs = Array.isArray(save.npcs) ? save.npcs : [];

  for (const [cid, snap] of Object.entries(snaps)) {
    if (!snap || typeof snap !== 'object') continue;

    // 主角专有块已废弃：连同旧档里残留的一起清掉（进度先搬到 identity.realmProgress）
    if (stripPlayerBlockInPlace(snap)) {
      fixed.push(`${cid}.player 已删除（主角专有块，2026-09-22 废弃；进度并入 identity.realmProgress）`);
    }

    // 修炼速度缓存已废弃（2026-09-22 删）：它是程序按「不含运气」的口径算出来写进快照的，
    // 与卡片上 AI 现算的数字是两套口径。公式与数据现在交给 AI，旧档残留一并清掉。
    if (snap.identity && typeof snap.identity === 'object' && snap.identity.cultivation !== undefined) {
      delete snap.identity.cultivation;
      fixed.push(`${cid}.identity.cultivation 已删除（程序预算的修炼速度，2026-09-22 废弃）`);
    }

    if (snap.bio && isPersonalityLeak(snap.bio.longTermGoal)) {
      snap.bio.longTermGoal = '';
      fixed.push(`${cid}.bio.longTermGoal 清掉串门的性格摘要`);
    }

    if (!snap.identity) continue;
    if (!looksLikeCharId(snap.identity.name)) continue;      // 名字正常，不动

    let healed = '';
    if (cid === 'B1') healed = charRealName || saveRealName;
    else {
      const rec = npcs.find(n => n && n.id === cid && n.name && !looksLikeCharId(n.name));
      healed = rec ? String(rec.name).trim() : '';
    }
    // 修不出来就清空 —— 宁可界面显示「未命名」，也不要顶着 B1 当人名
    snap.identity.name = healed || '';
    fixed.push(`${cid}.identity.name ${healed ? '→ ' + healed : '清空（找不到真名）'}`);
  }

  if (save.character && looksLikeCharId(save.character.name)) {
    const healed = charRealName || saveRealName || '';
    save.character.name = healed;
    fixed.push(`character.name ${healed ? '→ ' + healed : '清空'}`);
  }
  return fixed;
}
