import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { computeAttrs, rootDisplayName, ATTR_KEYS, normalizeDims, personalityTraits, personalityBrief, centeredDims, ITEMS, TRAITS, TRAIT_RARITIES, resolveTraitMods, traitCatalogEntry } from '../data/gameData.js';
import PersonalityDims from '../components/PersonalityDims.jsx';
import { api } from '../api.js';
import { CHARACTER_GROUPS, newCharacter, persistCharSnapshots } from '../saveModel.js';
import { clampSnapshotStats, isCharClamped } from '../data/attrClamp.js';
import { getEffectiveTables } from '../data/numericTuning.js';
import { safeEquipment, NPC_COLUMN_LABELS } from '../engine/mortalCommands.js';
import { buildCharNameIndex, relationRows } from '../engine/charNames.js';
import {
  snapshotFromCharacter, validateSnapshot, slotValueText, EQUIP_SLOT_LABELS,
  getEquipSlot, setEquipSlot, newEquipmentSlots, normalizeEquipment, attrRows, attrBonusHint, ATTR_LABELS, characterAttrMods, characterClampBonus,
  invItemName, invItemQty, invItemSubtype, invItemGrade, invItemModsText, modsToText, parseModsText,
  makeInvItem, normalizeInvItem, invItemMatchesSlot, INV_ITEM_TYPES, INV_SUBTYPE_CANDIDATES, INV_GRADE_CANDIDATES,
  equippedSlotMap, equippedSlotsOf, ensureInvEntry,
} from '../data/snapshotSchema.js';
import { buildSkill, skillCoefText, skillLineText, poolCtxOf, bandOf, SKILL_TYPES, DMG_KINDS, ATTACK_RANGE_MIN, ATTACK_RANGE_MAX, rangeLabel, diceTextForGrade, normalizeAttackRange } from '../data/skillCodex.js';
import { useToast, useConfirm, Spinner } from '../ui.jsx';

const TABS = ['基本信息', '装备', '储物袋', '属性', '技能', '特质', '性格', '关系', '快照'];

// 数值表约束开关（角色名册 · 基本信息）：豁免后该角色不参与数值表强制校界
// 标记落在角色本体（save.character.numericClamp / npc.numericClamp），缺省 = 受约束
function NumericClampRow({ value, onChange, globalOff }) {
  const clamped = value !== false;
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <label>数值表约束</label>
      <div className="btn-row">
        <button className={`small ${clamped ? 'primary' : ''}`} onClick={() => onChange(true)}>受约束</button>
        <button className={`small ${clamped ? '' : 'primary'}`} onClick={() => onChange(false)}>豁免</button>
      </div>
      <div className="hint">
        {clamped
          ? '受约束：血量、法力、物攻、物防、法攻、法防、物理穿透、法术穿透、脚力、神识 按所在境界的基准校界，越界值会被写回边界。'
          : '已豁免：以上属性不参与校界，完全保留 AI 演化或你手动填写的值。'}
        {' 气运、魅力、会心在境界基准表中没有对应列 —— 按境界区间的校界管不到它们；另按固定上下限钳制：气运 0~100（满值正好供 40% 暴击率），会心不许为负（本身无上限，超出必暴的部分会折成暴击伤害）。'}
        {globalOff ? '全局「强制校界」已关闭，此项暂不生效' : ''}
      </div>
    </div>
  );
}

// 查看人物：右侧滑出面板（不占据全部空间，❌ 关闭）
export default function CharacterPanel({ save, updateSave, saveNow, onClose, settings }) {
  const c = save.character;
  const [selId, setSelId] = useState('protagonist'); // 主角默认选中
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState('');
  const [newNpcName, setNewNpcName] = useState('');
  const [relEditing, setRelEditing] = useState(null); // 关系编辑 {target, relation, desc, idx}
  const toast = useToast();
  const confirmDlg = useConfirm();

  const npcs = save.npcs || [];
  const isProtagonist = selId === 'protagonist';
  const sel = isProtagonist ? null : npcs.find(n => n.id === selId);

  const filteredNpcs = useMemo(() => {
    const q = search.trim();
    if (!q) return npcs;
    return npcs.filter(n => n.name.includes(q));
  }, [npcs, search]);

  const updateNpc = (mutator, persist = true) => {
    const list = npcs.map(n => n.id === selId ? mutator(n) : n);
    const s = { ...save, npcs: list };
    updateSave(s);
    if (persist) saveNow(s);
  };
  const updateProtagonist = (mutator) => {
    const s = { ...save, character: mutator({ ...save.character }) };
    updateSave(s); saveNow(s);
  };

  const addNpc = () => {
    const name = newNpcName.trim();
    if (!name) return;
    const npc = newCharacter({ name });
    const s = { ...save, npcs: [...npcs, npc] };
    updateSave(s); saveNow(s);
    setSelId(npc.id);
    setNewNpcName('');
    toast('ok', `角色「${name}」已创建`);
  };
  const delNpc = async (id) => {
    const npc = npcs.find(n => n.id === id);
    if (!await confirmDlg({ title: '删除角色', text: `确定删除角色「${npc?.name}」？该角色的名册条目与快照将被一并移除。`, danger: true, okText: '删除' })) return;
    // 名册与快照必须同步删除：只删名册条目的话，快照会沦为没有名册指向的孤儿
    //（名册里看不到它，但快照页按 id 仍能翻到），角色删除必须两边一起删。
    const { [id]: _removed, ...restSnaps } = (save.charSnapshots || {});
    const s = { ...save, npcs: npcs.filter(n => n.id !== id), charSnapshots: restSnaps };
    updateSave(s); saveNow(s);
    api.deleteCharSnapshot(save.id, id).catch(() => {}); // 服务端快照文件同步清理
    if (selId === id) setSelId('protagonist');
    toast('ok', `角色「${npc?.name}」已删除`);
  };

  return (
    <div className="char-drawer">
      {/* 这块面板＝「一块木板，上面贴着一张纸」：
           木板 = .char-drawer 自己的底色（深胡桃竖纹，padding 14px 留出四边木框）
           纸   = .char-drawer-head / .char-drawer-body 各自的浅宣纸底色
         所以这里**不需要任何额外的装饰元素**，纸边、木框、四角包角都由 CSS 画
         （见 guigu-fx.css §2）。打开时整块板子从右向左拉开。 */}
      <div className="char-drawer-head">
        <h2>角色名册</h2>
        <button className="ghost small" onClick={onClose} title="关闭" aria-label="关闭角色面板">✕</button>
      </div>
      <div className="char-drawer-body">
        {/* 左：角色列表 */}
        <div className="char-list-col">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索角色…" style={{ width: '100%', marginBottom: 8 }} />
          <div className="char-add-row">
            <input type="text" value={newNpcName} onChange={e => setNewNpcName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNpc()} placeholder="新角色名…" style={{ flex: 1 }} />
            <button className="small primary" onClick={addNpc}>＋新建</button>
          </div>
          {CHARACTER_GROUPS.map(g => {
            const list = g === '主角' ? [{ id: 'protagonist', name: c.name, subtitle: `玩家 · ${c.realm?.name} · ${c.race?.name}` }] : filteredNpcs.filter(n => n.group === g);
            if (!list.length) return null;
            return (
              <div className="char-group" key={g}>
                <div className="char-group-title">{g} <span className="tab-cnt">{list.length}</span></div>
                {list.map(n => (
                  <div key={n.id} className={`char-item ${selId === n.id ? 'active' : ''}`} onClick={() => { setSelId(n.id); setTab(0); }}>
                    <div>
                      <div className="char-item-name">{n.name}</div>
                      <div className="char-item-sub">{n.subtitle}</div>
                    </div>
                    {n.id !== 'protagonist' && (
                      <button className="small danger" onClick={e => { e.stopPropagation(); delNpc(n.id); }}>删</button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {/* 兜底：分组名不在 CHARACTER_GROUPS 里的角色也要显示（历史上自动建册用过「登场人物」等分组） */}
          {(() => {
            const rest = filteredNpcs.filter(n => !CHARACTER_GROUPS.includes(n.group));
            if (!rest.length) return null;
            return (
              <div className="char-group">
                <div className="char-group-title">登场人物 <span className="tab-cnt">{rest.length}</span></div>
                {rest.map(n => (
                  <div key={n.id} className={`char-item ${selId === n.id ? 'active' : ''}`} onClick={() => { setSelId(n.id); setTab(0); }}>
                    <div>
                      <div className="char-item-name">{n.name}</div>
                      <div className="char-item-sub">{n.subtitle}</div>
                    </div>
                    <button className="small danger" onClick={e => { e.stopPropagation(); delNpc(n.id); }}>删</button>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* 右：角色详情 */}
        <div className="char-detail-col">
          <div className="inner">
            {isProtagonist ? (
              <ProtagonistDetail save={save} updateSave={updateSave} saveNow={saveNow} tab={tab} setTab={setTab} settings={settings} />
            ) : sel ? (
              <NpcDetail npc={sel} save={save} updateSave={updateSave} saveNow={saveNow} tab={tab} setTab={setTab} updateNpc={updateNpc} relEditing={relEditing} setRelEditing={setRelEditing} settings={settings} />
            ) : (
              <div className="empty-tip">选择左侧角色查看详情</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailHeader({ name, subtitle, tab, setTab, children }) {
  return (
    <>
      <div className="char-detail-head">
        <div>
          <h2>{name}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{subtitle}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>{children}</div>
      </div>
      <div className="tabs">
        {TABS.map((t, i) => <button key={t} className={i === tab ? 'active' : ''} onClick={() => setTab(i)}>{t}</button>)}
      </div>
    </>
  );
}

// ---- 主角：所有栏目直接读快照（save.charSnapshots.B1，AI 注入同一数据源） ----
function ProtagonistDetail({ save, updateSave, saveNow, tab, setTab, settings }) {
  const c = save.character;
  const toast = useToast();
  // 快照数据源：名册/装备/属性/物品全部从快照读取（与 AI 提示词注入一致）
  const snap = save.charSnapshots?.B1 || snapshotFromCharacter(c, {
    id: 'B1', kind: 'player', isPlayer: true, locationName: save.world?.location?.name,
  });
  const idt = snap.identity || {};
  const act = snap.action || {};
  const numericExempt = save.character?.numericClamp === false;

  // 快照变更统一入口：写存档 + 落服务端（AI 下一回合即可读到实时装备）
  const patchSnapshot = useCallback((mutator) => {
    const next = structuredClone(snap);
    mutator(next);
    const s = { ...save, charSnapshots: { ...(save.charSnapshots || {}), B1: next } };
    updateSave(s);
    saveNow(s);
    persistCharSnapshots(save.id, { B1: next });
  }, [snap, save, updateSave, saveNow]);

  // 数值表约束开关：写角色本体（save.character.numericClamp），豁免后不参与强制校界
  const setCharClamp = (v) => {
    const s = { ...save, character: { ...save.character, numericClamp: v } };
    updateSave(s); saveNow(s);
  };

  // ===== 装备：从储物袋选装备到槽位 / 卸下（实时写快照） =====
  // 口径：储物袋 = 「拥有清单」，数量含穿在身上的那件；装备槽只表示这几件里哪一件在身。
  // 所以穿 / 脱都**不改数量**，储物袋里那条目始终留着（列表里标「已装备」）。
  const equipItem = (group, slotKey, invItem) => {
    if (!invItem) return;
    const itName = invItemName(invItem);
    const itObj = invItem && typeof invItem === 'object' ? invItem : null;
    patchSnapshot(sn => {
      // 先把老结构（整串字符串 / 内衣格等老键）归一成标准槽位：否则往字符串组里写会整组被顶掉
      const eqNorm = normalizeEquipment(sn.equipment || newEquipmentSlots());
      sn.equipment = setEquipSlot(eqNorm, group, slotKey, {
        name: itName, type: itObj?.type || '装备', subtype: itObj?.subtype || '', grade: itObj?.grade || '',
        appearance: itObj?.appearance || '', desc: itObj?.desc || '', mods: itObj?.mods || null, quantity: 1,
      });
      sn.inventory = ensureInvEntry(sn.inventory, {
        name: itName, type: itObj?.type || '装备', subtype: itObj?.subtype || '', grade: itObj?.grade || '',
        appearance: itObj?.appearance || '', desc: itObj?.desc || '', mods: itObj?.mods || null,
        source: '装备补登',
      });
    });
    toast('ok', `已装备「${itName}」`);
  };
  const unequipSlot = (group, slotKey) => {
    const cur = getEquipSlot(normalizeEquipment(snap.equipment || newEquipmentSlots()), group, slotKey);
    if (!cur || !cur.name) return;
    patchSnapshot(sn => {
      const eqNorm = normalizeEquipment(sn.equipment || newEquipmentSlots());
      sn.equipment = setEquipSlot(eqNorm, group, slotKey, null);
      // 数量不动：储物袋里那条本来就是这件，脱下只是不再穿在身上
      sn.inventory = ensureInvEntry(sn.inventory, {
        name: cur.name, type: cur.type || '装备', subtype: cur.subtype || '', grade: cur.grade || '',
        appearance: cur.appearance || '', desc: cur.desc || '', mods: cur.mods || null,
        source: '卸下补登',
      });
    });
    toast('ok', `已卸下「${cur.name}」，物品仍留在储物袋`);
  };

  const inventory = snap.inventory || [];
  // 已装备判定：储物袋列表据此标「已装备」，避免玩家把同一件东西当成两件
  const equippedMap = equippedSlotMap(snap.equipment);
  const traitList = Array.isArray(snap.traits) ? snap.traits : [];

  // 储物袋：点击物品查看详情 / 弹窗添加或编辑物品
  const [invDetail, setInvDetail] = useState(null);
  const [invAddOpen, setInvAddOpen] = useState(false);
  const [invEdit, setInvEdit] = useState(null);   // 正在编辑的物品（null = 未在编辑）
  const addInventoryItem = (item) => {
    patchSnapshot(sn => { sn.inventory = [...(sn.inventory || []), item]; });
    toast('ok', `已添加「${item.name}」×${item.quantity}`);
  };
  // 编辑已有物品：按原名称定位后整条替换（AI 写漏品阶时玩家能在这里补齐）
  const saveInventoryItem = (item) => {
    const orig = invEdit;
    if (!orig) return;
    const origName = invItemName(orig);
    patchSnapshot(sn => {
      const list = [...(sn.inventory || [])];
      const i = list.findIndex(x => invItemName(x) === origName);
      if (i >= 0) list[i] = { ...list[i], ...item }; else list.push(item);
      sn.inventory = list;
      // 装备槽里的同名物品一并更新（两处本是同一件东西）
      sn.equipment = syncEquippedItem(sn.equipment, origName, item);
    });
    toast('ok', `已保存「${item.name}」`);
  };

  // 性格维度：拖动时即时反映到界面，落盘合并成一次，避免一拖一串请求；
  // 写入前统一走 normalizeDims，把老数据里用右名当键的写法一并折算掉。
  const persSaveTimer = useRef(null);
  const persDims = normalizeDims(c.personality?.dims);
  const persTags = personalityTraits(c.personality?.dims);
  const applyPersDims = (dims) => {
    // 性格维度同时写进主角快照的「性格」栏，保证名册、详情、提示词读到的是同一份
    const charSnapshots = { ...(save.charSnapshots || {}) };
    if (charSnapshots.B1) {
      charSnapshots.B1 = { ...charSnapshots.B1, identity: { ...(charSnapshots.B1.identity || {}), personality: personalityBrief(dims) } };
    }
    const s = { ...save, charSnapshots, character: { ...c, personality: { ...(c.personality || {}), dims } } };
    updateSave(s);
    clearTimeout(persSaveTimer.current);
    persSaveTimer.current = setTimeout(() => saveNow(s), 350);
  };
  const setPersDim = (key, v) => {
    if (persDims[key] === v) return;
    applyPersDims({ ...persDims, [key]: v });
  };

  return (
    <>
      <DetailHeader name={`${c.name} · 主角`} subtitle={`${idt.gender || c.gender} · ${idt.realm || c.realm?.name} · ${idt.linggen || rootDisplayName(c.root)}`} tab={tab} setTab={setTab}>
        <span className="tag" style={{ color: 'var(--gold-dim)' }}>数据源：角色快照</span>
      </DetailHeader>

      {tab === 0 && (
        <>
          <div className="kv"><span className="k">姓名</span><span className="v">{T(idt.name, '—')}</span></div>
          <div className="kv"><span className="k">身份</span><span className="v">{T(c.origin?.name)}</span></div>
          <div className="kv"><span className="k">性别</span><span className="v">{T(idt.gender, '—')}</span></div>
          <div className="kv"><span className="k">种族</span><span className="v">{T(c.race?.name)}</span></div>
          <div className="kv"><span className="k">境界</span><span className="v">{T(idt.realm, '—')}</span></div>
          <div className="kv"><span className="k">灵根</span><span className="v">{T(idt.linggen, '—')}</span></div>
          <div className="kv"><span className="k">年龄 / 寿元</span><span className="v">{idt.age ?? '—'} 岁 / {idt.shouyuan ?? '—'}</span></div>
          <div className="kv"><span className="k">人称</span><span className="v">{c.person}</span></div>
          <div className="kv"><span className="k">性格</span><span className="v">{T(idt.personality, '—')}</span></div>
          <div className="kv"><span className="k">当前行为</span><span className="v" style={{ fontSize: 12 }}>{T(act.action, '未记录')}</span></div>
          <div className="kv"><span className="k">位置</span><span className="v" style={{ fontSize: 12 }}>{T(act.location, save.world?.location?.name || '—')}{(act.coordinates || []).length ? ` (${act.coordinates.join(',')})` : ''}</span></div>
          {act.attire && <div className="kv"><span className="k">着装</span><span className="v" style={{ fontSize: 12 }}>{T(act.attire)}</span></div>}
          <NumericClampRow
            value={save.character?.numericClamp}
            onChange={setCharClamp}
            globalOff={settings?.numericTuning?.enforce === false}
          />
        </>
      )}

      {tab === 1 && (
        <EquipmentSlots snap={snap} inventory={inventory} onEquip={equipItem} onUnequip={unequipSlot} />
      )}

      {tab === 2 && (
        <>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className="small primary" onClick={() => setInvAddOpen(true)}>＋ 添加物品</button>
          </div>
          {inventory.length ? inventory.map((it, i) => (
            <button className="inv-line inv-item-row" key={i} onClick={() => setInvDetail(it)} title="点击查看详情">
              <InvItemLines it={it} equippedSlots={equippedSlotsOf(equippedMap, invItemName(it))} />
            </button>
          )) : <div className="empty-tip">储物袋空空如也</div>}
          <div className="hint" style={{ marginTop: 8 }}>点击物品查看详情；装备请切到「装备」页，点击槽位从储物袋选择。标着「已装备」的物品此刻正穿在身上，与装备栏里那件是同一样东西，不是两件。</div>
        </>
      )}

      {tab === 3 && (
        <>
          <div className="notice">数值为实际生效值，已含后面的加值；「+N」是这一项的总加成，鼠标悬停可查看来源。</div>
          {numericExempt && <div className="notice">该角色已豁免数值表约束，属性不会被强制改回区间。</div>}
          <AttrNumberList rows={attrRows(snap, characterAttrMods(save, snap, snap?.id))} />
        </>
      )}

      {tab === 4 && (snap.skills?.length ? snap.skills.map((s, i) => {
        const sk = buildSkill(s);
        if (!sk) return null;
        const coef = skillCoefText(sk, poolCtxOf(snap));
        return (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div className="row1">
              <span className="name">{T(sk.name)}</span>
              <span className="cost">{T([sk.type, sk.dmgKind, sk.grade].filter(Boolean).join(' · '))}</span>
            </div>
            <div className="desc">{T(sk.effect)}</div>
            {coef && <div className="desc" style={{ opacity: 0.75 }}>{T(coef)}</div>}
          </div>
        );
      }) : <div className="empty-tip">尚未习得技能</div>)}

      {tab === 5 && (traitList.length ? traitList.map((t, i) => {
        const isStr = typeof t === 'string';
        const name = isStr ? t : (t?.name || '?');
        const rarity = !isStr && t.rarity ? t.rarity : '';
        // 特质完整描述：desc 为主，effects 为补充效果；词条优先读快照 mods，缺失时回查造化阁特质库
        const desc = !isStr ? (t.desc || t.description || '') : (TRAITS.find(x => x.name === name)?.desc || '');
        const effects = !isStr ? (t.effects || '') : '';
        // 词条一律按特质库解析（程序权威）：库里有就用库里的，库里没有才用快照自带的
        const mods = resolveTraitMods(t);
        const modsText = modsToText(mods);
        return (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div className="row1"><span className="name">{name}</span>{rarity ? <span className="cost">{rarity}</span> : null}</div>
            {desc ? <div className="desc">{desc}</div> : null}
            {effects ? <div className="desc" style={{ color: 'var(--text-dim)' }}>{effects}</div> : null}
            {modsText ? <div className="trait-mods-line">词条：{modsText}</div> : null}
          </div>
        );
      }) : <div className="empty-tip">尚未觉醒特质</div>)}

      {tab === 6 && (
        <>
          <div className="pers-summary">
            <span>性格偏向</span>
            {persTags.length
              ? persTags.map(t => <span className="pers-chip" key={t.key} title={t.gloss}>{t.side} {t.value}/6</span>)
              : <span className="pers-none">各维度居中，无明显偏向</span>}
            <button className="small ghost" style={{ marginLeft: 'auto' }}
              onClick={() => applyPersDims(centeredDims())}>全部恢复居中</button>
          </div>
          <PersonalityDims dims={persDims} onChange={setPersDim} />
          <div className="notice" style={{ marginTop: 10 }}>每项 0 到 6 分，3 为居中；偏哪一侧，哪一侧的名字就会加粗。按住拖动或点击即可调整，鼠标悬停可查看该维度的含义。</div>
        </>
      )}

      {tab === 7 && (
        <>
          <div className="kv"><span className="k">关系</span><span className="v">{(snap.bio?.rawRelations || []).length} 条</span></div>
          <RelationList save={save} relations={snap.bio?.rawRelations}
            emptyText="主角关系：由剧情演化中的 NPC 互动生成，可在 NPC 页手动维护" />
        </>
      )}

      {tab === 8 && <SnapshotTab save={save} updateSave={updateSave} charId="B1" kind="player" name={c.name} settings={settings} />}

      {invDetail && (
        <ItemDetailModal item={invDetail} onClose={() => setInvDetail(null)}
          actions={<button className="primary" onClick={() => { setInvEdit(invDetail); setInvDetail(null); }}>编辑</button>} />
      )}
      {invAddOpen && <ItemAddModal onAdd={addInventoryItem} onClose={() => setInvAddOpen(false)} />}
      {invEdit && <ItemAddModal initial={invEdit} onSave={saveInventoryItem} onClose={() => setInvEdit(null)} />}
    </>
  );
}

// ===== 装备槽系统：每个槽位可从储物袋选装备穿上，实时写快照 =====
// 兼容匹配：物品的类型/子类/名称任一命中关键词（旧数据 type='武器' 与新数据 type='装备'+subtype='武器' 均可命中）
const SLOT_COMPAT = {
  weapon: ['武器', '兵器', '剑', '刀', '枪', '棍'],
  armor: ['防具', '衣物', '护甲', '内甲', '袍', '甲'],
  accessory: ['饰品', '配饰', '环', '佩', '链'],
  treasure: ['法宝', '宝物'],
  technique: ['功法', '秘籍', '书籍'],
};

// 物品元信息一行：类型 · 子类 · 品阶（空段自动省略）
export function invItemMetaText(it) {
  if (!it || typeof it !== 'object') return '';
  return [it.type, invItemSubtype(it), invItemGrade(it)].filter(Boolean).join(' · ');
}

// ===== 储物袋行：名称/数量一行，元信息、词条、描述各自成行 =====
// 历史 bug：旧实现把「名称 · 类型 · 描述 · 词条」整串塞进 .kv 的 .k 列（固定 100px + nowrap），
// 长文本横向溢出到右侧「×数量 · 来源」上，看起来像文字重叠。这里改为纵向多行布局，
// 名称单独占一行（超长省略号），描述换到下一行，任何长度都不会再压到右侧。
// equippedSlots：这件物品此刻被穿在哪些槽位（储物袋数量含在身的那件，故要标「已装备」）
export function InvItemLines({ it, equippedSlots = null }) {
  const meta = invItemMetaText(it);
  const slots = Array.isArray(equippedSlots) ? equippedSlots.filter(Boolean) : [];
  const mods = it && typeof it === 'object' ? invItemModsText(it.mods) : '';
  const desc = it && typeof it === 'object' ? String(it.desc || '') : '';
  const src = it && typeof it === 'object' && it.lots?.[0]?.source ? String(it.lots[0].source) : '';
  return (
    <>
      <span className="inv-line-head">
        <span className="inv-line-name">{invItemName(it) || '?'}</span>
        {slots.length ? <span className="equipped-badge" title={`正穿在身上：${slots.join('、')}`}>已装备</span> : null}
        <span className="inv-line-qty">×{invItemQty(it)}</span>
      </span>
      {(meta || src || slots.length) && (
        <span className="inv-line-meta">
          {meta ? <span className="tag">{meta}</span> : null}
          {slots.length ? <span className="inv-line-where">{slots.join('、')} 在身</span> : null}
          {src ? <span className="inv-line-src">来源：{src}</span> : null}
        </span>
      )}
      {mods ? <span className="inv-line-mods">{mods}</span> : null}
      {desc ? <span className="inv-line-desc">{desc}</span> : null}
    </>
  );
}

// 储物袋条目被编辑后，同步更新装备槽里同名的那一件 —— 两处本就是同一件物品，
// 不同步的话玩家从装备页点开看到的还是旧品阶（未标注）。
function syncEquippedItem(eq, oldName, next) {
  const out = normalizeEquipment(eq || newEquipmentSlots());
  if (!oldName) return out;
  const groups = [
    ['weapon', ['right', 'left']],
    ['armor', ['head', 'inner', 'armor', 'hands', 'legs', 'feet', 'cloak']],
    ['accessory', [0, 1, 2, 3, 4, 5]],
    ['treasure', [0, 1, 2, 3, 4, 5]],
    ['technique', [0, 1, 2, 3, 4, 5]],
  ];
  for (const [g, keys] of groups) {
    for (const k of keys) {
      const v = getEquipSlot(out, g, k);
      if (v && invItemName(v) === oldName) {
        return setEquipSlot(out, g, k, {
          name: next.name, type: next.type || v.type, subtype: next.subtype || v.subtype,
          grade: next.grade || '', appearance: next.appearance || '', desc: next.desc || '',
          mods: next.mods || null, quantity: 1,
        });
      }
    }
  }
  return out;
}

// ===== 物品详情弹窗（储物袋/装备界面点击物品查看） =====
export function ItemDetailModal({ item, title, onClose, actions }) {
  const it = normalizeInvItem(item);
  const modsText = invItemModsText(it.mods);
  // 类型/品阶这类关键字段即使为空也要显示「未标注」——否则整行不渲染，
  // 玩家看到的是「详情里什么都没有」，分不清是没数据还是界面出错。
  const Row = ({ k, v, placeholder }) => {
    const empty = v === '' || v == null;
    if (empty && !placeholder) return null;
    return (
      <div className="kv">
        <span className="k">{k}</span>
        <span className="v" style={{ fontSize: 12, ...(empty ? { color: 'var(--text-dim)' } : null) }}>{empty ? placeholder : v}</span>
      </div>
    );
  };
  return (
    <div className="modal-overlay" onClick={ev => ev.target === ev.currentTarget && onClose()}>
      <div className="modal item-detail-modal">
        <div className="modal-head">
          <h3>{title || it.name || '未命名物品'}</h3>
          <button className="ghost small" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <Row k="类型" v={[it.type, it.subtype].filter(Boolean).join(' · ')} placeholder="未标注" />
          <Row k="品阶" v={it.grade} placeholder="未标注" />
          <Row k="数量" v={`×${it.quantity}`} />
          <Row k="外观" v={it.appearance} />
          {it.desc ? (
            <div className="kv"><span className="k">描述</span><span className="v" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{it.desc}</span></div>
          ) : null}
          {modsText ? (
            <div className="kv"><span className="k">属性</span><span className="v" style={{ fontSize: 12, color: 'var(--gold)' }}>{modsText}</span></div>
          ) : null}
          {it.lots?.[0]?.source ? (
            <div className="kv"><span className="k">来源</span><span className="v" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{it.lots[0].source}</span></div>
          ) : null}
        </div>
        {actions ? <div className="modal-foot">{actions}</div> : null}
      </div>
    </div>
  );
}

// ===== 物品弹窗（全字段表单）：添加 / 编辑共用 =====
// 传 initial 即为「编辑」——AI 演化写漏品阶时，玩家能在这里直接补上。
export function ItemAddModal({ onAdd, onClose, initial = null, onSave = null }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState(initial?.type || '杂物');
  const [subtype, setSubtype] = useState(initial?.subtype || '');
  const [quantity, setQuantity] = useState(Math.max(1, Math.floor(Number(initial?.quantity) || 1)));
  const [appearance, setAppearance] = useState(initial?.appearance || '');
  const [desc, setDesc] = useState(initial?.desc || '');
  const [grade, setGrade] = useState(initial?.grade || '');
  const [mods, setMods] = useState(initial ? invItemModsText(initial.mods) : '');
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    const item = makeInvItem({
      name: n, type, subtype: subtype.trim(), quantity,
      appearance: appearance.trim(), desc: desc.trim(), grade: grade.trim(), mods: parseModsText(mods),
    });
    if (editing) onSave?.(item); else onAdd?.(item);
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={ev => ev.target === ev.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3>{editing ? '编辑物品' : '添加物品'}</h3>
          <button className="ghost small" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>名称 <span className="lbl-note">必填</span></label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
          <div className="field"><label>类型</label>
            <select value={type} onChange={e => setType(e.target.value)}>
              {INV_ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div className="field"><label>子类 <span className="lbl-note">可留空，例：武器 / 饰品 / 丹药</span></label>
            <input type="text" value={subtype} onChange={e => setSubtype(e.target.value)} list="inv-subtype-list" /></div>
          <div className="btn-row">
            <div className="field" style={{ flex: 1 }}><label>数量</label>
              <input type="number" min="1" value={quantity}
                onChange={e => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /></div>
            <div className="field" style={{ flex: 1 }}><label>品阶 <span className="lbl-note">1~36 品，如「三品」</span></label>
              <input type="text" value={grade} onChange={e => setGrade(e.target.value)} list="inv-grade-list" /></div>
          </div>
          <div className="field"><label>外观 <span className="lbl-note">可留空</span></label>
            <input type="text" value={appearance} onChange={e => setAppearance(e.target.value)} /></div>
          <div className="field"><label>描述</label>
            <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} /></div>
          <div className="field"><label>属性 <span className="lbl-note">可留空，例：物攻=9000，法防=100</span></label>
            <input type="text" value={mods} onChange={e => setMods(e.target.value)} placeholder="物攻=9000，法防=100" /></div>
          <datalist id="inv-subtype-list">{INV_SUBTYPE_CANDIDATES.map(s => <option key={s} value={s} />)}</datalist>
          <datalist id="inv-grade-list">{INV_GRADE_CANDIDATES.map(g => <option key={g} value={g} />)}</datalist>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>{editing ? '保存' : '添加'}</button>
        </div>
      </div>
    </div>
  );
}

// ===== 装备选择弹窗：只显示可装备到该槽位的储物袋物品 =====
function EquipPickModal({ inventory, compat, slotLabel, equippedMap, onPick, onClose }) {
  const [showAll, setShowAll] = useState(false);
  const compatItems = inventory.filter(it => invItemMatchesSlot(it, compat));
  const list = showAll ? inventory : compatItems;
  return (
    <div className="modal-overlay" onClick={ev => ev.target === ev.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <h3>选择装备 · {slotLabel}</h3>
          <button className="ghost small" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          {list.length === 0 ? (
            <div className="empty-tip">
              {showAll ? '储物袋空空如也' : `储物袋中没有可装备到「${slotLabel}」的物品`}
              {!showAll && inventory.length > 0 && (
                <div style={{ marginTop: 8 }}><button className="small ghost" onClick={() => setShowAll(true)}>显示全部物品</button></div>
              )}
            </div>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 8, fontSize: 11 }}>
                {showAll ? '正在显示全部物品' : `可装备物品 ${compatItems.length} 件`}
                {inventory.length > compatItems.length && (
                  <button className="small ghost" style={{ marginLeft: 8 }} onClick={() => setShowAll(v => !v)}>
                    {showAll ? '只看兼容物品' : '显示全部'}
                  </button>
                )}
              </div>
              {list.map((it, i) => {
                const nm = invItemName(it) || '?';
                const typeText = [it && typeof it === 'object' ? it.type : '', invItemSubtype(it), invItemGrade(it)].filter(Boolean).join(' · ');
                const modsText = it && typeof it === 'object' ? invItemModsText(it.mods) : '';
                const desc = it && typeof it === 'object' ? it.desc : '';
                return (
                  <button className="equip-pick-item" key={i} onClick={() => onPick(it)} title={desc || nm}>
                    <span className="equip-pick-name">{nm}</span>
                    {equippedSlotsOf(equippedMap, nm).length ? (
                      <span className="equipped-badge" title={`正穿在：${equippedSlotsOf(equippedMap, nm).join('、')}`}>已装备</span>
                    ) : null}
                    {typeText ? <span className="equip-pick-type">{typeText}</span> : null}
                    <span className="equip-pick-qty">×{invItemQty(it)}</span>
                    {modsText ? <span className="equip-pick-mods">{modsText}</span> : null}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function EquipmentSlots({ snap, inventory, onEquip, onUnequip }) {
  // 装备槽里可能残留 Mortal 内部实例 id（I_C1_01）：显示前先按储物袋反查名称，查不到则视为空槽
  const eq = useMemo(() => normalizeEquipment(safeEquipment(snap)) || newEquipmentSlots(), [snap]);
  // 选择装备时把「已装备」标出来：同一件东西还穿在别的槽上，避免玩家以为袋子里还有一件
  const equippedMap = useMemo(() => equippedSlotMap(eq), [eq]);
  const [pick, setPick] = useState(null);     // 待选择装备的槽位 { group, slotKey, label, compat }
  const [detail, setDetail] = useState(null); // 已装备物品详情 { group, slotKey, item }
  const groups = [
    { group: 'weapon', label: '兵器', keys: ['right', 'left'] },
    { group: 'armor', label: '防具', keys: ['head', 'inner', 'armor', 'hands', 'legs', 'feet', 'cloak'] },
    { group: 'accessory', label: '饰品', keys: [0, 1, 2, 3, 4, 5] },
    { group: 'treasure', label: '法宝', keys: [0, 1, 2, 3, 4, 5] },
    { group: 'technique', label: '功法', keys: [0, 1, 2, 3, 4, 5] },
  ];
  return (
    <div className="equip-slots">
      <div className="notice">点击空槽位从储物袋选择装备；点击已装备物品可查看详情。卸下只是脱下，物品始终留在储物袋里（数量不变）。</div>
      {groups.map(({ group, label, keys }) => {
        const g = eq[group];
        // 旧字符串结构（weapon/armor/accessory 顶格字符串）直接显示
        if (typeof g === 'string') {
          return (
            <div className="equip-group" key={group}>
              <div className="equip-group-title">{label}</div>
              <div className="kv"><span className="k">装备</span><span className="v">{g || '—'}</span></div>
            </div>
          );
        }
        return (
          <div className="equip-group" key={group}>
            <div className="equip-group-title">{label}</div>
            <div className="equip-slot-grid">
              {keys.map(key => {
                const value = getEquipSlot(eq, group, key);
                const slotLabel = EQUIP_SLOT_LABELS[key] || `${label} ${Number(key) + 1}`;
                return (
                  <SlotCell key={String(key)} group={group} slotKey={key} label={slotLabel} value={value}
                    compat={SLOT_COMPAT[group]} onPick={setPick} onDetail={setDetail} onUnequip={onUnequip} />
                );
              })}
            </div>
          </div>
        );
      })}

      {pick && (
        <EquipPickModal inventory={inventory} compat={pick.compat} slotLabel={pick.label} equippedMap={equippedMap}
          onPick={it => { onEquip(pick.group, pick.slotKey, it); setPick(null); }}
          onClose={() => setPick(null)} />
      )}
      {detail && (
        <ItemDetailModal item={detail.item} onClose={() => setDetail(null)}
          actions={
            <>
              <button className="danger" onClick={() => { onUnequip(detail.group, detail.slotKey); setDetail(null); }}>卸下</button>
              <button className="primary" onClick={() => { const d = detail; setDetail(null); setPick({ group: d.group, slotKey: d.slotKey, label: d.label, compat: d.compat }); }}>更换装备</button>
            </>
          } />
      )}
    </div>
  );
}

// 单个装备槽（两列网格内）：空槽点击打开选择窗；已装备点击查看详情
function SlotCell({ group, slotKey, label, value, compat, onPick, onDetail, onUnequip }) {
  // value 可能为 null（空槽）——typeof null === 'object' 直接读 .desc 会崩
  const equipped = value == null ? '' : (typeof value === 'object' ? (value.name || slotValueText(value)) : value);
  const isObj = value != null && typeof value === 'object';
  const openPick = () => onPick({ group, slotKey, label, compat });
  return (
    <div className="equip-slot-cell">
      <span className="equip-slot-label">{label}</span>
      {equipped ? (
        <>
          <button className="equip-slot-val equipped" title="点击查看详情"
            onClick={() => onDetail({ group, slotKey, label, compat, item: value })}>
            {isObj && value.grade ? <span className="equip-slot-grade">{value.grade}</span> : null}
            {equipped}
          </button>
          <button className="small ghost equip-slot-unequip" onClick={() => onUnequip(group, slotKey)}>卸下</button>
        </>
      ) : (
        <button className="equip-slot-val empty" onClick={openPick}>＋ 选择装备…</button>
      )}
    </div>
  );
}

// ===== 属性数字列表 =====
// 数值 = 实际生效值（已把下面的加值算进去）；括号里的「+N」= 这一项总共加了多少（装备 + 人物自身），
// 鼠标悬停看这笔加成的来源。加值只在括号里写一次，不再另起「装备 +N / 自身 +N」的标签。
function AttrNumberList({ rows }) {
  return (
    <div className="attr-num-list">
      {rows.map(r => (
        <div className="attr-num-row" key={r.key}>
          <span className="label">{r.label}</span>
          <span className="nums">
            {r.isPool ? `${r.effCurrent} / ${r.effMax}` : r.effCurrent}{r.key === 'crit' ? '%' : ''}
            {!!r.total && (
              <span className={`bonus-total ${r.total > 0 ? 'up' : 'down'}`}
                title={attrBonusHint(r)}>（{r.total > 0 ? '+' : ''}{r.total}{r.key === 'crit' ? '%' : ''}）</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- NPC ----
function NpcDetail({ npc, save, updateSave, saveNow, tab, setTab, updateNpc, relEditing, setRelEditing, settings }) {
  const toast = useToast();
  // 快照数据源：与主角一致（save.charSnapshots 优先；无快照时从名册字段合成仅用于展示，编辑后才落快照）
  const rawSnap = save.charSnapshots?.[npc.id] || null;
  const snap = rawSnap || {
    id: npc.id, kind: 'npc', isPlayer: false,
    identity: { name: npc.name, gender: npc.gender || '', race: npc.race || '', realm: npc.realm || '' },
    action: {}, stats: {}, status: {},
    inventory: Array.isArray(npc.inventory) ? npc.inventory : [],
    equipment: npc.equipment || newEquipmentSlots(),
    skills: [], traits: [], bio: {},
  };
  const idt = snap.identity || {};
  const act = snap.action || {};
  const numericExempt = npc.numericClamp === false;
  const inventory = snap.inventory || [];
  const traitList = Array.isArray(snap.traits) ? snap.traits : [];
  // 已装备判定：NPC 储物袋同样标注，免得同一件东西在装备栏与储物袋被当成两件
  const equippedMap = equippedSlotMap(snap.equipment);

  // 快照变更统一入口：写存档 + 落服务端 + 同步快照文件（AI 下一回合即读到最新值）
  const patchSnapshot = useCallback((mutator) => {
    const next = structuredClone(rawSnap || snap);
    mutator(next);
    const s = { ...save, charSnapshots: { ...(save.charSnapshots || {}), [npc.id]: next } };
    updateSave(s);
    saveNow(s);
    persistCharSnapshots(save.id, { [npc.id]: next });
  }, [rawSnap, snap, save, updateSave, saveNow, npc.id]);

  // ===== 装备：从储物袋选装备到槽位 / 卸下（与主角同一套 EquipmentSlots 交互） =====
  // 与主角同一口径：储物袋 = 拥有清单（数量含在身那件），穿 / 脱都不改数量。
  const equipItem = (group, slotKey, invItem) => {
    if (!invItem) return;
    const itName = invItemName(invItem);
    const itObj = invItem && typeof invItem === 'object' ? invItem : null;
    patchSnapshot(sn => {
      // 先把老结构（整串字符串 / 内衣格等老键）归一成标准槽位：否则往字符串组里写会整组被顶掉
      const eqNorm = normalizeEquipment(sn.equipment || newEquipmentSlots());
      sn.equipment = setEquipSlot(eqNorm, group, slotKey, {
        name: itName, type: itObj?.type || '装备', subtype: itObj?.subtype || '', grade: itObj?.grade || '',
        appearance: itObj?.appearance || '', desc: itObj?.desc || '', mods: itObj?.mods || null, quantity: 1,
      });
      sn.inventory = ensureInvEntry(sn.inventory, {
        name: itName, type: itObj?.type || '装备', subtype: itObj?.subtype || '', grade: itObj?.grade || '',
        appearance: itObj?.appearance || '', desc: itObj?.desc || '', mods: itObj?.mods || null,
        source: '装备补登',
      });
    });
    toast('ok', `已装备「${itName}」`);
  };
  const unequipSlot = (group, slotKey) => {
    const cur = getEquipSlot(normalizeEquipment(snap.equipment || newEquipmentSlots()), group, slotKey);
    if (!cur || !cur.name) return;
    patchSnapshot(sn => {
      const eqNorm = normalizeEquipment(sn.equipment || newEquipmentSlots());
      sn.equipment = setEquipSlot(eqNorm, group, slotKey, null);
      // 数量不动：储物袋里那条本来就是这件，脱下只是不再穿在身上
      sn.inventory = ensureInvEntry(sn.inventory, {
        name: cur.name, type: cur.type || '装备', subtype: cur.subtype || '', grade: cur.grade || '',
        appearance: cur.appearance || '', desc: cur.desc || '', mods: cur.mods || null,
        source: '卸下补登',
      });
    });
    toast('ok', `已卸下「${cur.name}」，物品仍留在储物袋`);
  };

  const [invDetail, setInvDetail] = useState(null);
  const [invAddOpen, setInvAddOpen] = useState(false);
  const [invEdit, setInvEdit] = useState(null);   // 正在编辑的物品（null = 未在编辑）
  const addInventoryItem = (item) => {
    patchSnapshot(sn => { sn.inventory = [...(sn.inventory || []), item]; });
    toast('ok', `已添加「${item.name}」×${item.quantity}`);
  };
  const saveInventoryItem = (item) => {
    const orig = invEdit;
    if (!orig) return;
    const origName = invItemName(orig);
    patchSnapshot(sn => {
      const list = [...(sn.inventory || [])];
      const i = list.findIndex(x => invItemName(x) === origName);
      if (i >= 0) list[i] = { ...list[i], ...item }; else list.push(item);
      sn.inventory = list;
      // 装备槽里的同名物品一并更新（两处本是同一件东西）
      sn.equipment = syncEquippedItem(sn.equipment, origName, item);
    });
    toast('ok', `已保存「${item.name}」`);
  };

  return (
    <>
      <DetailHeader name={npc.name} subtitle={`${npc.group} · ${npc.subtitle || npc.realm || ''}`} tab={tab} setTab={setTab}>
        <select value={npc.group} onChange={e => updateNpc(n => ({ ...n, group: e.target.value }))}>
          {CHARACTER_GROUPS.filter(g => g !== '主角').map(g => <option key={g}>{g}</option>)}
        </select>
        <span className="tag" style={{ color: 'var(--gold-dim)' }}>数据源：角色快照</span>
      </DetailHeader>

      {tab === 0 && (
        <>
          <div className="field"><label>姓名</label>
            <input type="text" value={npc.name} onChange={e => updateNpc(n => ({ ...n, name: e.target.value }), false)} onBlur={() => saveNow({ ...save })} />
          </div>
          <div className="field"><label>副标题 <span className="lbl-note">身份简述</span></label>
            <input type="text" value={npc.subtitle || ''} onChange={e => updateNpc(n => ({ ...n, subtitle: e.target.value }), false)} onBlur={() => saveNow({ ...save })} placeholder="如：黄枫谷外门弟子" />
          </div>
          <div className="kv"><span className="k">性别</span><span className="v">{T(idt.gender, npc.gender || '—')}</span></div>
          <div className="kv"><span className="k">种族</span><span className="v">{T(idt.race, npc.race || '—')}</span></div>
          <div className="kv"><span className="k">境界</span><span className="v">{T(idt.realm, npc.realm || '—')}</span></div>
          <div className="kv"><span className="k">性格</span><span className="v">{T(idt.personality, '—')}</span></div>
          <div className="kv"><span className="k">当前行为</span><span className="v" style={{ fontSize: 12 }}>{T(act.action, '未记录')}</span></div>
          <div className="kv"><span className="k">位置</span><span className="v" style={{ fontSize: 12 }}>{T(act.location, '—')}</span></div>
          {act.attire && <div className="kv"><span className="k">着装</span><span className="v" style={{ fontSize: 12 }}>{T(act.attire)}</span></div>}
          <NumericClampRow
            value={npc.numericClamp}
            onChange={(v) => updateNpc(n => ({ ...n, numericClamp: v }))}
            globalOff={settings?.numericTuning?.enforce === false}
          />
          <div className="hint" style={{ marginTop: 8 }}>身份、状态等细节可在「快照」页内联编辑。</div>
        </>
      )}

      {tab === 1 && (
        <EquipmentSlots snap={snap} inventory={inventory} onEquip={equipItem} onUnequip={unequipSlot} />
      )}

      {tab === 2 && (
        <>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className="small primary" onClick={() => setInvAddOpen(true)}>＋ 添加物品</button>
          </div>
          {inventory.length ? inventory.map((it, i) => (
            <button className="inv-line inv-item-row" key={i} onClick={() => setInvDetail(it)} title="点击查看详情">
              <InvItemLines it={it} equippedSlots={equippedSlotsOf(equippedMap, invItemName(it))} />
            </button>
          )) : <div className="empty-tip">储物袋空空如也</div>}
          <div className="hint" style={{ marginTop: 8 }}>点击物品查看详情；装备请切到「装备」页，点击槽位从储物袋选择。标着「已装备」的物品此刻正穿在身上，与装备栏里那件是同一样东西，不是两件。</div>
        </>
      )}

      {tab === 3 && (
        <>
          <div className="notice">数值为实际生效值，已含后面的加值；「+N」是这一项的总加成，鼠标悬停可查看来源。</div>
          {numericExempt && <div className="notice">该角色已豁免数值表约束，属性不会被强制改回区间。</div>}
          <AttrNumberList rows={attrRows(snap, characterAttrMods(save, snap, snap?.id))} />
        </>
      )}

      {tab === 4 && (snap.skills?.length ? snap.skills.map((s, i) => {
        const sk = buildSkill(s);
        if (!sk) return null;
        const coef = skillCoefText(sk, poolCtxOf(snap));
        return (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div className="row1"><span className="name">{T(sk.name)}</span><span className="cost">{T([sk.type, sk.dmgKind, sk.grade].filter(Boolean).join(' · '))}</span></div>
            <div className="desc">{T(sk.effect)}</div>
            {coef && <div className="desc" style={{ opacity: 0.75 }}>{T(coef)}</div>}
          </div>
        );
      }) : <div className="empty-tip">尚未习得技能 · 由剧情演化自动生成</div>)}

      {tab === 5 && (traitList.length ? traitList.map((t, i) => {
        const isStr = typeof t === 'string';
        const name = isStr ? t : (t?.name || '?');
        const rarity = !isStr && t.rarity ? t.rarity : '';
        const desc = !isStr ? (t.desc || t.description || '') : (TRAITS.find(x => x.name === name)?.desc || '');
        const effects = !isStr ? (t.effects || '') : '';
        // 词条一律按特质库解析（程序权威）：库里有就用库里的，库里没有才用快照自带的
        const mods = resolveTraitMods(t);
        const modsText = modsToText(mods);
        return (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div className="row1"><span className="name">{name}</span>{rarity ? <span className="cost">{rarity}</span> : null}</div>
            {desc ? <div className="desc">{desc}</div> : null}
            {effects ? <div className="desc" style={{ color: 'var(--text-dim)' }}>{effects}</div> : null}
            {modsText ? <div className="trait-mods-line">词条：{modsText}</div> : null}
          </div>
        );
      }) : <div className="empty-tip">尚未觉醒特质 · 由剧情演化自动生成</div>)}

      {tab === 6 && (
        idt.personality
          ? <div className="kv"><span className="k">性格</span><span className="v">{T(idt.personality)}</span></div>
          : <div className="empty-tip">NPC 性格由剧情演化生成，暂不支持手动修改</div>
      )}

      {tab === 7 && (
        <>
          {/* 演化关系：来自快照 bio.rawRelations（由 state/upstore 的 rel.X.Y 指令维护），只读 */}
          {(snap.bio?.rawRelations || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="kv"><span className="k">关系</span><span className="v">{snap.bio.rawRelations.length} 条 · 由剧情演化维护</span></div>
              <RelationList save={save} relations={snap.bio.rawRelations} />
            </div>
          )}

          {/* 手工关系：存在名册角色本体（npc.relations），可增删改；下一回合会被并入演化上下文 */}
          <div className="btn-row"><button className="primary small" onClick={() => setRelEditing({ target: '', relation: '', desc: '' })}>＋ 添加关系</button></div>
          {(npc.relations || []).length ? npc.relations.map((r, i) => (
            <div className="card" key={i} style={{ marginBottom: 8 }}>
              <div className="row1">
                <span className="name">{r.target}</span>
                <span className="tag">{r.relation}</span>
                <span style={{ flex: 1 }} />
                <button className="small" onClick={() => setRelEditing({ ...r, idx: i })}>编辑</button>
                <button className="small danger" onClick={() => updateNpc(n => ({ ...n, relations: n.relations.filter((_, j) => j !== i) }))}>删除</button>
              </div>
              {r.desc && <div className="desc">{r.desc}</div>}
            </div>
          )) : (
            <div className="empty-tip">
              {(snap.bio?.rawRelations || []).length > 0 ? '没有手工添加的关系' : '暂无关系记录'}
            </div>
          )}

          {relEditing && (
            <div className="modal-overlay" onClick={ev => ev.target === ev.currentTarget && setRelEditing(null)}>
              <div className="modal" style={{ maxWidth: 440 }}>
                <div className="modal-head"><h3>{relEditing.idx != null ? '编辑关系' : '添加关系'}</h3><button className="ghost small" onClick={() => setRelEditing(null)}>✕</button></div>
                <div className="modal-body">
                  <div className="field"><label>对象 <span className="lbl-note">角色名</span></label><input type="text" value={relEditing.target} onChange={e => setRelEditing({ ...relEditing, target: e.target.value })} /></div>
                  <div className="field"><label>关系 <span className="lbl-note">例：挚友 / 师徒 / 仇敌</span></label><input type="text" value={relEditing.relation} onChange={e => setRelEditing({ ...relEditing, relation: e.target.value })} /></div>
                  <div className="field"><label>备注</label><textarea value={relEditing.desc} onChange={e => setRelEditing({ ...relEditing, desc: e.target.value })} /></div>
                </div>
                <div className="modal-foot">
                  <button onClick={() => setRelEditing(null)}>取消</button>
                  <button className="primary" disabled={!relEditing.target.trim()} onClick={() => {
                    const { idx, ...data } = relEditing;
                    updateNpc(n => {
                      const rels = [...(n.relations || [])];
                      if (idx != null) rels[idx] = data; else rels.push(data);
                      return { ...n, relations: rels };
                    });
                    setRelEditing(null);
                  }}>保存</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 8 && <SnapshotTab save={save} updateSave={updateSave} charId={npc.id} kind="npc" name={npc.name} settings={settings} />}

      {invDetail && (
        <ItemDetailModal item={invDetail} onClose={() => setInvDetail(null)}
          actions={<button className="primary" onClick={() => { setInvEdit(invDetail); setInvDetail(null); }}>编辑</button>} />
      )}
      {invAddOpen && <ItemAddModal onAdd={addInventoryItem} onClose={() => setInvAddOpen(false)} />}
      {invEdit && <ItemAddModal initial={invEdit} onSave={saveInventoryItem} onClose={() => setInvEdit(null)} />}
    </>
  );
}

/* ============================================================
   快照 Tab：解析并展示当前角色快照
   - 直接编辑：快照界面关键字段内联修改（身份/状态/行动/生平/肖像）
   - 编辑 JSON：高级模式，整体 JSON 编辑
   - 保存后同步 save.charSnapshots（AI 提示词即刻读到最新值）
   ============================================================ */
function SnapshotTab({ save, updateSave, charId, kind, name, settings }) {
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);       // JSON 编辑模式
  const [fieldEdit, setFieldEdit] = useState(false);   // 字段直编模式
  const [draftSnap, setDraftSnap] = useState(null);    // 字段直编工作副本
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  const localSnap = save.charSnapshots?.[charId] || null;
  const load = useCallback(async () => {
    setLoading(true);
    // 数据源优先级：存档内 charSnapshots（名册与 AI 注解读的就是它）→ 服务端副本 → 按角色信息构造。
    // 旧版只读服务端副本，于是「快照页改 A、名册读 B」：保存后名册那侧纹丝不动，看着像保存失败。
    if (localSnap) { setSnap(localSnap); setLoading(false); return; }
    try {
      const rec = await api.getCharSnapshot(save.id, charId);
      setSnap(rec.snapshot);
    } catch (e) {
      // 不存在则按角色信息构造一个初始快照
      const initial = snapshotFromCharacter(save.character, { id: charId, kind, isPlayer: kind === 'player', locationName: save.world?.location?.name });
      setSnap(initial);
    } finally {
      setLoading(false);
    }
  }, [save.id, save.character, save.world?.location?.name, charId, kind, localSnap]);

  useEffect(() => { load(); }, [load]);

  const beginEdit = () => {
    setDraft(JSON.stringify(snap, null, 2));
    setEditing(true);
    setValid(validateSnapshot(snap));
  };
  const cancelEdit = () => { setEditing(false); setDraft(''); setValid(null); };

  // 数值校界：手填属性若越出数值表区间（如超过该境界上限），按表强制写回边界。
  // 校界只针对「剥离装备 / 特质 / 出身 / 种族 / 加点加成后的裸值」——加成带来的升降不算越界。
  // （「数值表」页可关闭强制校界；角色在「基本信息」里选了豁免则对该角色不校界；境界不在表中时原样放行）
  const enforceGuard = (obj) => {
    if (settings?.numericTuning?.enforce === false) return { obj, note: '' };
    if (!isCharClamped(save, charId, obj)) return { obj, note: ' · 该角色已豁免数值表约束' };
    try {
      const r = clampSnapshotStats(obj, getEffectiveTables(settings?.numericTuning), {
        // 校界用 characterClampBonus（只含出身/种族/加点：特质与装备在自身之外实时叠加，不参与区间），
        // 与「数值表」页、演化合并三处同一口径；属性栏展示则用 characterAttrMods（特质段）。
        id: charId, name, mods: characterClampBonus(save, obj, charId),
      });
      if (!r.changes.length) return { obj, note: '' };
      return { obj: r.snapshot, note: ` · 数值校界修正 ${r.changes.length} 处` };
    } catch { return { obj, note: '' }; }
  };

  // 保存快照：写服务端 + 同步存档内快照集合（AI 提示词数据源）
  const saveSnapshot = async (rawObj) => {
    setSaving(true);
    const { obj, note } = enforceGuard(rawObj);
    try {
      await api.putCharSnapshot(save.id, charId, obj);
      setSnap(obj);
      // 主角与 NPC 都要同步回存档：名册（基本信息/装备/属性/储物袋）读的就是 save.charSnapshots，
      // 旧版只同步主角，导致 NPC 在快照页改完、名册其它页仍是旧数据。
      const s = { ...save, charSnapshots: { ...(save.charSnapshots || {}), [charId]: obj } };
      updateSave(s);
      toast('ok', '快照已保存' + note);
      return true;
    } catch (e) {
      toast('err', '保存失败：' + e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onDraftChange = (v) => {
    setDraft(v);
    try {
      const obj = JSON.parse(v);
      setValid(validateSnapshot(obj));
    } catch (e) {
      setValid({ ok: false, errors: [{ code: 'parse', msg: e.message }] });
    }
  };

  const applyEdit = async () => {
    let obj;
    try { obj = JSON.parse(draft); }
    catch (e) { return toast('err', 'JSON 解析失败：' + e.message); }
    const v = validateSnapshot(obj);
    if (!v.ok) {
      const cont = confirm('快照有 ' + v.errors.length + ' 条校验失败：\n' + v.errors.map(x => '· ' + x.msg).join('\n') + '\n\n仍然保存？');
      if (!cont) return;
    }
    if (await saveSnapshot(obj)) { setEditing(false); setValid(null); }
  };

  // 字段直编：onPatch 按路径写入工作副本
  const patchField = (path, value) => {
    setDraftSnap(prev => {
      const next = structuredClone(prev);
      const keys = path.split('.');
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const beginFieldEdit = () => { setDraftSnap(structuredClone(snap)); setFieldEdit(true); };
  const applyFieldEdit = async () => {
    if (await saveSnapshot(draftSnap)) setFieldEdit(false);
  };

  if (loading) return <div className="loading-tip"><Spinner /> 读取快照中…</div>;

  // 展示模式
  return (
    <div className="snapshot-tab">
      <div className="section-head-row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{name} 的角色快照</h3>
        <span className="spacer" />
        {!editing && !fieldEdit ? (
          <>
            <button className="small ghost" onClick={load} disabled={saving}>刷新</button>
            <button className="small" onClick={beginEdit}>编辑 JSON</button>
            <button className="small primary" onClick={beginFieldEdit}>编辑字段</button>
          </>
        ) : fieldEdit ? (
          <>
            <button className="small ghost" onClick={() => setFieldEdit(false)}>取消</button>
            <button className="small primary" onClick={applyFieldEdit} disabled={saving}>{saving ? <Spinner /> : '保存修改'}</button>
          </>
        ) : (
          <>
            <button className="small ghost" onClick={cancelEdit}>取消</button>
            <button className="small primary" onClick={applyEdit} disabled={saving}>{saving ? <Spinner /> : '保存'}</button>
          </>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            className="preset-content-input"
            style={{ minHeight: 360, fontFamily: 'var(--font-mono, monospace)' }}
            value={draft}
            onChange={e => onDraftChange(e.target.value)}
          />
          {valid && (
            <div className={`snapshot-validation ${valid.ok ? 'ok' : 'err'}`}>
              {valid.ok ? (
                <span className="tag ok">✓ 校验通过</span>
              ) : (
                <>
                  <span className="tag err">✗ {valid.errors.length} 项不合规</span>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                    {valid.errors.slice(0, 12).map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e.msg}</li>)}
                  </ul>
                </>
              )}
              {valid.warnings?.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                  警告：{valid.warnings.length} 项推荐字段缺失，不影响保存
                </div>
              )}
            </div>
          )}
        </>
      ) : fieldEdit ? (
        <SnapshotView snap={draftSnap} editable onPatch={patchField} save={save} />
      ) : (
        <SnapshotView snap={snap} save={save} />
      )}
    </div>
  );
}

// 装备卡片行构造：兼容旧字符串结构与新版槽位对象/数组结构
// weapon: 'xxx' | { right, left }
// armor: 'xxx' | { head, inner, armor, hands, legs, feet, cloak }
// accessory: 'xxx' | [槽位...]; treasure / technique: [槽位...]; techniques: { k: v }
function equipmentRows(eq) {
  const rows = [];
  const add = (key, label, value) => rows.push({ key, label, text: slotValueText(value) || '—' });
  const isPlainObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

  if (isPlainObj(eq.weapon)) {
    for (const [k, v] of Object.entries(eq.weapon)) add(`weapon-${k}`, `${EQUIP_SLOT_LABELS[k] || k}兵器`, v);
  } else {
    add('weapon', '兵器', eq.weapon);
  }

  if (isPlainObj(eq.armor)) {
    for (const [k, v] of Object.entries(eq.armor)) add(`armor-${k}`, EQUIP_SLOT_LABELS[k] || k, v);
  } else {
    add('armor', '防具', eq.armor);
  }

  if (Array.isArray(eq.accessory)) {
    eq.accessory.forEach((v, i) => add(`acc-${i}`, `饰品 ${i + 1}`, v));
  } else {
    add('accessory', '饰品', eq.accessory);
  }

  if (Array.isArray(eq.treasure)) eq.treasure.forEach((v, i) => add(`treasure-${i}`, `法宝 ${i + 1}`, v));
  if (Array.isArray(eq.technique)) eq.technique.forEach((v, i) => add(`technique-${i}`, `功法 ${i + 1}`, v));

  if (isPlainObj(eq.techniques) && Object.keys(eq.techniques).length) {
    add('techniques', '功法槽', Object.entries(eq.techniques).map(([k, v]) => `${k}:${slotValueText(v)}`).filter(s => !s.endsWith(':')).join(' / '));
  }

  if (!rows.length) rows.push({ key: 'none', label: '装备', text: '—' });
  return rows;
}

// 文本安全转换：AI 输出的字段可能是对象/数组，直接渲染会导致 React 崩溃
function T(v, fallback = '') {
  const t = slotValueText(v);
  return t || fallback;
}

// ===== 关系列表（名册「关系」tab 与快照「关系」栏目共用） =====
// 快照里的关系用内部 ID 记人（B1=主角、C1…=NPC），这里统一翻成姓名再渲染，
// 避免玩家看到「B1」这种 Mortal 内部标识。
export function RelationList({ save, relations, emptyText = '暂无关系记录' }) {
  const rows = useMemo(
    () => relationRows(relations, buildCharNameIndex(save)),
    [relations, save]
  );
  if (!rows.length) return <div className="empty-tip">{emptyText}</div>;
  return (
    <div className="rel-list">
      {rows.map(r => (
        <div className="rel-row" key={r.key}>
          <div className="rel-head">
            <span className="rel-name">{r.name}</span>
            {r.label ? <span className="tag rel-label">{r.label}</span> : null}
            <span style={{ flex: 1 }} />
            {r.favText ? <span className={`rel-fav${r.fav < 0 ? ' neg' : r.fav > 0 ? ' pos' : ''}`}>{r.favText}</span> : null}
          </div>
          {r.desc ? <div className="rel-desc">{T(r.desc)}</div> : null}
          {r.cognition ? <div className="rel-cognition">认知：{T(r.cognition)}</div> : null}
        </div>
      ))}
    </div>
  );
}


// 快照内联编辑行：editable 时渲染输入框，否则渲染文本
function Ekv({ label, value, editable, onPatch, path, type = 'text', area = false }) {
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className="v">
        {editable ? (
          area ? (
            <textarea className="snap-edit-input" rows={2} value={value ?? ''} onChange={e => onPatch(path, e.target.value)} />
          ) : (
            <input className="snap-edit-input" type={type} value={value ?? ''}
              onChange={e => onPatch(path, type === 'number' ? (Number(e.target.value) || 0) : e.target.value)} />
          )
        ) : (value === '' || value == null ? '—' : value)}
      </span>
    </div>
  );
}

// ===== 储物袋编辑：属性加成输入（草稿失焦提交，避免 "物攻=" 中途被 parse 吞字） =====
function InvModsInput({ mods, onSubmit, placeholder }) {
  const [draft, setDraft] = useState(invItemModsText(mods));
  useEffect(() => { setDraft(invItemModsText(mods)); }, [mods]);
  return (
    <input className="snap-edit-input inv-edit-mods" placeholder={placeholder || '属性加成 · 可选，例：物攻=9000，法防=100'}
      value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => onSubmit(parseModsText(draft))} />
  );
}

// ===== 储物袋编辑：单条物品编辑行（名称/数量/类型/子类/品阶/外观/描述/加成/删除） =====
function InvItemEditor({ item, index, onPatchItem, onRemove, equippedSlots = null }) {
  const it = normalizeInvItem(item);
  const set = (field, value) => onPatchItem(index, field, value);
  const slots = Array.isArray(equippedSlots) ? equippedSlots.filter(Boolean) : [];
  return (
    <div className="inv-edit-item">
      {slots.length ? (
        <div className="hint" style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="equipped-badge">已装备</span>
          <span>{slots.join('、')} 在身 · 这里的数量已含这件</span>
        </div>
      ) : null}
      <div className="inv-edit-row">
        <input className="snap-edit-input inv-edit-name" placeholder="名称" value={it.name}
          onChange={e => set('name', e.target.value)} />
        <input className="snap-edit-input inv-edit-qty" type="number" min="1" value={it.quantity}
          onChange={e => set('quantity', Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
        <input className="snap-edit-input inv-edit-type" list="inv-type-list" placeholder="类型" value={it.type}
          onChange={e => set('type', e.target.value)} />
        <input className="snap-edit-input inv-edit-subtype" list="inv-subtype-list2" placeholder="子类 · 可留空" value={it.subtype || ''}
          onChange={e => set('subtype', e.target.value)} />
        <input className="snap-edit-input inv-edit-grade" list="inv-grade-list2" placeholder="品阶" value={it.grade || ''}
          onChange={e => set('grade', e.target.value)} />
        <button className="small ghost" onClick={() => onRemove(index)}>删除</button>
      </div>
      <input className="snap-edit-input inv-edit-appearance" placeholder="外观 · 可留空" value={it.appearance || ''}
        onChange={e => set('appearance', e.target.value)} />
      <input className="snap-edit-input inv-edit-desc" placeholder="描述 · 可选" value={it.desc || ''}
        onChange={e => set('desc', e.target.value)} />
      <InvModsInput mods={it.mods} onSubmit={v => set('mods', v)} />
    </div>
  );
}

// ===== 技能/特质编辑行（快照字段直编模式） =====
function normSkill(s) {
  const base = (typeof s === 'string')
    ? { name: s }
    : {
      name: s?.name ?? '', type: s?.type, grade: s?.grade ?? s?.category, dmgKind: s?.dmgKind,
      // 战斗新增的两个字段要原样带过来，否则在这行里改一下名字就会把 AI 写的骰子与距离弄丢
      range: s?.攻击距离 ?? s?.range,
      dice: s?.骰子 ?? s?.dice ?? s?.伤害骰,
      effect: s?.effect ?? s?.description ?? s?.desc,
    };
  // 名称被清空时 buildSkill 返回 null，这里用裸字段兜底，保证输入框不炸
  return buildSkill(base) || { name: base.name, type: '伤害', grade: '', band: '基础', dmgKind: '', effect: base.effect || '', dmgMult: 1, costRatio: 1 / 30, recoverRatio: null, range: normalizeAttackRange(base.range), dice: base.dice || '' };
}
function SkillEditRow({ skill, index, ctx, onPatchItem, onRemove }) {
  const s = normSkill(skill);
  const set = (f, v) => onPatchItem(index, f, v);
  const coef = skillCoefText(s, ctx);
  const isDmg = s.type === '伤害';
  return (
    <div className="inv-edit-item">
      <div className="inv-edit-row">
        <input className="snap-edit-input inv-edit-name" placeholder="技能名" value={s.name} onChange={e => set('name', e.target.value)} />
        <select className="snap-edit-input inv-edit-grade" value={s.type} onChange={e => set('type', e.target.value)}>
          {SKILL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="snap-edit-input inv-edit-grade" value={s.dmgKind || ''} onChange={e => set('dmgKind', e.target.value)} title="伤害属性：物走物攻/物防，法走法攻/法防">
          <option value="">（未标注）</option>
          {DMG_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="snap-edit-input inv-edit-grade" placeholder="品阶（如 三品）" value={s.grade} onChange={e => set('grade', e.target.value)} />
        <button className="small ghost" onClick={() => onRemove(index)}>删除</button>
      </div>
      <div className="inv-edit-row">
        <label className="snap-edit-label" title="战斗里够得着的格数。1 = 贴身，2~3 中程，4~6 远程，7~8 超远（地图只有 15×15）">
          攻击距离
          <input className="snap-edit-input inv-edit-grade" type="number" min={ATTACK_RANGE_MIN} max={ATTACK_RANGE_MAX} step={1}
            value={s.range} onChange={e => set('range', e.target.value)} />
          <span className="snap-edit-unit">{rangeLabel(s.range)}</span>
        </label>
        {isDmg && (
          <label className="snap-edit-label" title="战斗时掷的运气骰：掷两颗十面骰，点数只决定这一击运气好坏（平均是 1 倍），功法的威力由品阶决定。留空则按品阶自动生成">
            运气骰
            <input className="snap-edit-input inv-edit-grade" placeholder={diceTextForGrade(s.grade) || '按品阶'}
              value={s.dice || ''} onChange={e => set('dice', e.target.value)} />
          </label>
        )}
      </div>
      <textarea className="snap-edit-input inv-edit-desc" rows={2} placeholder="效果（一句用途说明）" value={s.effect || ''} onChange={e => set('effect', e.target.value)} />
      <div className="hint">{s.grade ? `属${bandOf(s.grade)}段 · ` : ''}倍率与耗灵力（按品阶与角色池自动算）：{coef || '—'}</div>
    </div>
  );
}
function normTrait(t) {
  if (typeof t === 'string') return { name: t, rarity: '', desc: '', effects: '', mods: null };
  return { ...(t || {}), name: t?.name || '', rarity: t?.rarity || '', desc: t?.desc || t?.description || '', effects: t?.effects || '', mods: t?.mods && typeof t.mods === 'object' ? t.mods : null };
}
function TraitEditRow({ trait, index, onPatchItem, onRemove }) {
  const t = normTrait(trait);
  const set = (f, v) => onPatchItem(index, f, v);
  // 特质库里的特质：词条（属性加成）由程序按特质库计算，这里只读展示，避免改了却不生效
  const catalogMods = resolveTraitMods(t.name);
  const catalogHit = traitCatalogEntry(t.name);
  return (
    <div className="inv-edit-item">
      <div className="inv-edit-row">
        <input className="snap-edit-input inv-edit-name" placeholder="特质名" value={t.name} onChange={e => set('name', e.target.value)} />
        <input className="snap-edit-input inv-edit-grade" list="trait-rarity-list" placeholder="稀有度" value={t.rarity} onChange={e => set('rarity', e.target.value)} />
        <button className="small ghost" onClick={() => onRemove(index)}>删除</button>
      </div>
      <textarea className="snap-edit-input inv-edit-desc" rows={2} placeholder="特质描述" value={t.desc || ''} onChange={e => set('desc', e.target.value)} />
      <input className="snap-edit-input inv-edit-appearance" placeholder="补充效果 · 可留空" value={t.effects || ''} onChange={e => set('effects', e.target.value)} />
      {catalogHit ? (
        <div className="hint" style={{ margin: '2px 0 0' }}>
          词条：{modsToText(catalogMods) || '无'}
        </div>
      ) : (
        <InvModsInput mods={t.mods} placeholder="属性词条 · 自定义特质，例：神识=-1，物防=2" onSubmit={v => set('mods', v)} />
      )}
    </div>
  );
}

// 快照视图：按栏目点选查看（一次只显示一个栏目），替代早期的一堆可折叠卡片。
// - 栏目列表由快照实际数据动态生成（没有数据的可选栏目不出现）
// - save 用于把关系里的内部 ID（B1/C1…）翻成姓名；不传时退回显示原 ID
export function SnapshotView({ snap, editable = false, onPatch, save, defaultCol = 'identity' }) {
  const [addOpen, setAddOpen] = useState(false);
  const [activeCol, setActiveCol] = useState(defaultCol);
  if (!snap) return <div className="empty-tip">暂无快照</div>;
  const idt = snap.identity || {};
  const status = snap.status || {};
  const act = snap.action || {};
  const bio = snap.bio || {};
  const eco = snap.economy || {};
  const eq = normalizeEquipment(safeEquipment(snap)) || {};   // 先清内部实例 id，再归一成标准槽位
  const eqMap = equippedSlotMap(eq);                          // 储物袋栏目据此标「已装备」
  const ca = snap.cultivationArts || {};
  const legacyCols = (snap.legacy && typeof snap.legacy === 'object' && snap.legacy.columns) ? snap.legacy.columns : {};
  const patch = (path, value) => onPatch && onPatch(path, value);

  // ===== 储物袋读写（兼容字符串 / 模板对象 / Mortal 实例 / AI 自由变体 4 种形态） =====
  const inv = Array.isArray(snap.inventory) ? snap.inventory : [];
  // AI 输出的数组字段可能是字符串/对象——统一安全化，防 .map/.length 崩溃
  const arr = v => Array.isArray(v) ? v : [];
  const relList = arr(bio.rawRelations), skillList = arr(snap.skills), traitList = arr(snap.traits);
  // 生平只有一个来源：bio.lifeStory
  const lifeText = String(bio.lifeStory || '');
  const patchInvItem = (index, field, value) => {
    if (!onPatch) return;
    const next = inv.map((it, i) => {
      if (i !== index) return it;
      const obj = normalizeInvItem(it);
      if (field === 'mods') obj.mods = value && Object.keys(value).length ? value : null;
      else if (field === 'quantity') obj.quantity = Math.max(1, Math.floor(Number(value) || 1));
      else {
        obj[field] = value;
        if (field === 'name') { obj.id = value; obj.definitionId = value; }
      }
      return obj;
    });
    onPatch('inventory', next);
  };
  const removeInvItem = (index) => onPatch && onPatch('inventory', inv.filter((_, i) => i !== index));
  const addInvItem = (item) => onPatch && onPatch('inventory', [...inv, item]);

  // 技能行的耗灵力/回复量按该角色自己的池现算，与注入文本、战斗结算同口径
  const skillCtx = poolCtxOf(snap);
  // ===== 技能/特质列表读写（字段直编模式） =====
  const patchListItem = (listPath, list, index, field, value) => {
    if (!onPatch) return;
    onPatch(listPath, list.map((x, i) => {
      if (i !== index) return x;
      const obj = listPath === 'skills' ? normSkill(x) : normTrait(x);
      if (field === 'mods') obj.mods = value && Object.keys(value).length ? value : null;
      else obj[field] = value;
      // 技能：改完名称/类型/品阶/效果立刻按品阶重算系数，保证落库的是最新值
      return listPath === 'skills' ? (buildSkill(obj) || obj) : obj;
    }));
  };

  // ===== 栏目定义 =====
  const cols = [];
  const col = (key, label, node, badge) => cols.push({ key, label, badge, node });

  col('identity', '身份', (
    <>
      <Ekv label="姓名" value={editable ? idt.name : T(idt.name, '—')} editable={editable} onPatch={patch} path="identity.name" />
      {editable ? (
        <>
          <Ekv label="性别" value={idt.gender} editable onPatch={patch} path="identity.gender" />
          <Ekv label="境界" value={idt.realm} editable onPatch={patch} path="identity.realm" />
        </>
      ) : (
        <div className="kv"><span className="k">性别 / 境界</span><span className="v">{T(idt.gender, '—')} · {T(idt.realm, '—')}</span></div>
      )}
      {editable ? (
        <>
          <Ekv label="年龄" value={idt.age} editable onPatch={patch} path="identity.age" type="number" />
          <Ekv label="寿元" value={idt.shouyuan} editable onPatch={patch} path="identity.shouyuan" type="number" />
          <Ekv label="灵根" value={idt.linggen} editable onPatch={patch} path="identity.linggen" />
          <Ekv label="性格" value={idt.personality} editable onPatch={patch} path="identity.personality" />
        </>
      ) : (
        <>
          <div className="kv"><span className="k">年龄 / 寿元</span><span className="v">{idt.age ?? '—'} 岁 / {idt.shouyuan ?? '—'}</span></div>
          {idt.linggen && <div className="kv"><span className="k">灵根</span><span className="v">{T(idt.linggen)}</span></div>}
          {idt.personality && <div className="kv"><span className="k">性格</span><span className="v" style={{ fontSize: 12 }}>{T(idt.personality)}</span></div>}
        </>
      )}
      {idt.aliasName && <div className="kv"><span className="k">化名</span><span className="v">{T(idt.aliasName)}</span></div>}
      {idt.disguiseRealm && <div className="kv"><span className="k">伪装境界</span><span className="v">{T(idt.disguiseRealm)}</span></div>}
      {Array.isArray(idt.identityRoles) && idt.identityRoles.length > 0 && <div className="kv"><span className="k">身份序列</span><span className="v">{idt.identityRoles.map(r => T(r)).filter(Boolean).join(' → ')}</span></div>}
      {/* 境界进度：主角与 NPC 同一口径（主角原有的「主角专属 · 进度」行已随该栏删除并入此处） */}
      {editable
        ? <Ekv label="境界进度" value={idt.realmProgress ?? 0} editable onPatch={patch} path="identity.realmProgress" type="number" />
        : (idt.realmProgress != null && <div className="kv"><span className="k">境界进度</span><span className="v">{idt.realmProgress}</span></div>)}
      {/* 修炼速度不在这里显示（2026-09-22 删）：它由公式算，而公式含「运气」浮动，
          程序算出来的只是一个不含运气的参考值，摆出来反而与卡片上的数字打架。
          真实数字由 AI 每场闭关现算写进 <cultivation_card>（见 data/cultivationParams.js）。 */}
      {editable ? <Ekv label="灵石" value={eco.spiritStones ?? 0} editable onPatch={patch} path="economy.spiritStones" type="number" />
        : <div className="kv"><span className="k">灵石</span><span className="v">{eco.spiritStones ?? '—'}</span></div>}
    </>
  ));

  col('stats', '属性', (
    <>
      {editable ? (
        <div className="attr-num-list">
          {Object.entries(snap.stats || {}).map(([k, v]) => {
            if (k === 'extra' || v == null) return null;
            const label = ATTR_LABELS[k] || k;
            if (typeof v === 'object' && !Array.isArray(v)) {
              return (
                <div className="attr-num-row" key={k}>
                  <span className="label">{label}</span>
                  <span className="nums attr-edit-nums">
                    <input className="snap-edit-input attr-edit-input" type="number" value={v.current ?? 0}
                      onChange={e => patch(`stats.${k}.current`, Number(e.target.value) || 0)} title="当前值" aria-label={`${label}当前值`} />
                    <span className="attr-edit-sep">/</span>
                    <input className="snap-edit-input attr-edit-input" type="number" value={v.max ?? 0}
                      onChange={e => patch(`stats.${k}.max`, Number(e.target.value) || 0)} title="上限" aria-label={`${label}上限`} />
                  </span>
                </div>
              );
            }
            return <Ekv key={k} label={label} value={v} editable onPatch={patch} path={`stats.${k}`} type="number" />;
          })}
        </div>
      ) : (
        <AttrNumberList rows={attrRows(snap, characterAttrMods(save, snap, snap?.id))} />
      )}
      <div className="kv"><span className="k">resources</span><span className="v">HP {snap.resources?.hp?.current ?? '—'}{snap.resources?.hp?.max != null ? `/${snap.resources.hp.max}` : ''} · MP {snap.resources?.mp?.current ?? '—'}{snap.resources?.mp?.max != null ? `/${snap.resources.mp.max}` : ''}</span></div>
    </>
  ));

  col('status', '状态', (
    <>
      <Ekv label="当前状态" value={editable ? status.current : T(status.current, '—')} editable={editable} onPatch={patch} path="status.current" area />
      {Array.isArray(status.buffs) && status.buffs.length > 0 && (
        <div className="kv"><span className="k">Buff</span><span className="v">{status.buffs.map(b => typeof b === 'string' ? b : (b.name || JSON.stringify(b))).join('、')}</span></div>
      )}
    </>
  ));

  col('action', '当前行动', (
    <>
      <Ekv label="动作" value={editable ? act.action : T(act.action, '—')} editable={editable} onPatch={patch} path="action.action" area />
      <Ekv label="地点" value={editable ? act.location : T(act.location, '—')} editable={editable} onPatch={patch} path="action.location" />
      {(act.coordinates || []).length > 0 && !editable && (
        <div className="kv"><span className="k">坐标</span><span className="v">{act.coordinates.join(',')}</span></div>
      )}
      {act.attire && <div className="kv"><span className="k">着装</span><span className="v" style={{ fontSize: 12 }}>{T(act.attire)}</span></div>}
      {act.figure && <div className="kv"><span className="k">体态</span><span className="v" style={{ fontSize: 12 }}>{T(act.figure)}</span></div>}
      {act.appearance && <div className="kv"><span className="k">外貌</span><span className="v" style={{ fontSize: 12 }}>{T(act.appearance)}</span></div>}
    </>
  ));

  col('bio', '生平', (
    <>
      <Ekv label="背景" value={bio.background} editable={editable} onPatch={patch} path="bio.background" area />
      <Ekv label="生平" value={lifeText} editable={editable} onPatch={patch} path="bio.lifeStory" area />
      <Ekv label="内心" value={bio.innerThought} editable={editable} onPatch={patch} path="bio.innerThought" area />
      <Ekv label="短期目标" value={bio.shortTermGoal} editable={editable} onPatch={patch} path="bio.shortTermGoal" area />
      <Ekv label="长期目标" value={bio.longTermGoal} editable={editable} onPatch={patch} path="bio.longTermGoal" area />
      <div className="kv"><span className="k">关系</span><span className="v">{relList.length} 条</span></div>
      <RelationList save={save} relations={relList} emptyText="暂无关系 · 由剧情演化自动生成" />
    </>
  ), relList.length || null);

  col('economy', '经济', (
    <>
      {editable ? (
        <>
          <Ekv label="灵石" value={eco.spiritStones ?? 0} editable onPatch={patch} path="economy.spiritStones" type="number" />
          <div className="eco-edit-row">
            {[['lowGrade', '低品'], ['midGrade', '中品'], ['highGrade', '高品'], ['topGrade', '顶品']].map(([k, lb]) => (
              <label key={k} className="eco-edit-cell">{lb}
                <input className="snap-edit-input" type="number" value={eco.spiritStoneBreakdown?.[k] ?? 0}
                  onChange={e => patch(`economy.spiritStoneBreakdown.${k}`, Number(e.target.value) || 0)} />
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="kv"><span className="k">灵石</span><span className="v">{eco.spiritStones ?? '—'}</span></div>
          {eco.spiritStoneBreakdown && (
            <div className="kv"><span className="k">明细</span><span className="v" style={{ fontSize: 12 }}>
              低 {eco.spiritStoneBreakdown.lowGrade || 0} · 中 {eco.spiritStoneBreakdown.midGrade || 0} · 高 {eco.spiritStoneBreakdown.highGrade || 0} · 顶 {eco.spiritStoneBreakdown.topGrade || 0}
            </span></div>
          )}
        </>
      )}
    </>
  ));

  col('equipment', '装备', (
    <>
      {equipmentRows(eq).map(r => (
        <div className="kv" key={r.key}><span className="k">{r.label}</span><span className="v" style={{ fontSize: 12 }}>{r.text}</span></div>
      ))}
    </>
  ));

  col('inventory', '储物袋', (
    <>
      {inv.length === 0 ? (
        <div className="empty-tip" style={{ padding: '8px 0' }}>空空如也</div>
      ) : editable ? (
        inv.map((it, i) => (
          <InvItemEditor key={i} item={it} index={i} equippedSlots={equippedSlotsOf(eqMap, invItemName(it))}
            onPatchItem={patchInvItem} onRemove={removeInvItem} />
        ))
      ) : inv.map((it, i) => (
        <div className="inv-line" key={i}>
          <InvItemLines it={it} equippedSlots={equippedSlotsOf(eqMap, invItemName(it))} />
        </div>
      ))}
      {editable && (
        <div style={{ marginTop: 8 }}>
          <button className="small primary" onClick={() => setAddOpen(true)}>＋ 添加物品</button>
        </div>
      )}
    </>
  ), inv.length || null);

  col('skills', '技能', (
    <>
      {editable ? (
        <>
          {skillList.map((s, i) => (
            <SkillEditRow key={i} skill={s} index={i} ctx={skillCtx}
              onPatchItem={(idx, f, v) => patchListItem('skills', skillList, idx, f, v)}
              onRemove={idx => onPatch && onPatch('skills', skillList.filter((_, j) => j !== idx))} />
          ))}
          <button className="small ghost" onClick={() => onPatch && onPatch('skills', [...skillList, buildSkill({ name: '新技能', type: '伤害', grade: '一品', effect: '' })])}>＋ 添加技能</button>
        </>
      ) : skillList.length === 0 ? (
        <div className="empty-tip" style={{ padding: '8px 0' }}>尚未习得</div>
      ) : skillList.map((s, i) => {
        const ns = normSkill(s);
        const coef = skillCoefText(ns, skillCtx);
        return (
          <div key={i}>
            <div className="kv"><span className="k" style={{ fontSize: 12 }}>{T(ns.name)}</span><span className="v" style={{ fontSize: 12 }}>{T([ns.type, ns.dmgKind, ns.grade].filter(Boolean).join(' · '))}</span></div>
            {ns.effect ? <div className="trait-desc-line">{T(ns.effect)}</div> : null}
            {coef ? <div className="trait-desc-line">{T(coef)}</div> : null}
          </div>
        );
      })}
    </>
  ), skillList.length || null);

  col('traits', '特质', (
    <>
      {editable ? (
        <>
          {traitList.map((t, i) => (
            <TraitEditRow key={i} trait={t} index={i}
              onPatchItem={(idx, f, v) => patchListItem('traits', traitList, idx, f, v)}
              onRemove={idx => onPatch && onPatch('traits', traitList.filter((_, j) => j !== idx))} />
          ))}
          <button className="small ghost" onClick={() => onPatch && onPatch('traits', [...traitList, { name: '新特质', rarity: '普通', desc: '', effects: '', mods: null }])}>＋ 添加特质</button>
        </>
      ) : traitList.length === 0 ? (
        <div className="empty-tip" style={{ padding: '8px 0' }}>尚未觉醒</div>
      ) : traitList.map((t, i) => {
        const nt = normTrait(t);
        const modsText = modsToText(resolveTraitMods(nt));
        return (
          <div key={i}>
            <div className="kv"><span className="k" style={{ fontSize: 12 }}>{T(nt.name)}</span><span className="v" style={{ fontSize: 12 }}>{T(nt.rarity)}</span></div>
            {nt.desc ? <div className="trait-desc-line">{T(nt.desc)}</div> : null}
            {nt.effects ? <div className="trait-desc-line" style={{ color: 'var(--text-dim)' }}>{T(nt.effects)}</div> : null}
            {modsText ? <div className="trait-mods-line">词条：{modsText}</div> : null}
          </div>
        );
      })}
    </>
  ), traitList.length || null);

  const artKeys = ['talisman', 'formation', 'alchemy', 'artifact', 'puppet', 'beastTaming', 'cooking', 'planting'].filter(k => ca[k]);
  if (artKeys.length) col('arts', '修仙百艺', (
    <>
      {artKeys.map(k => (
        <div className="kv" key={k}><span className="k" style={{ fontSize: 12 }}>{k}</span><span className="v">{ca[k].tier} · {ca[k].progress ?? 0}%</span></div>
      ))}
    </>
  ), artKeys.length);

  // Mortal 协议原始列留档：state/upstore 的 add(...)/npc.X={...} 会按原列号写进 legacy.columns，
  // 已映射的列同时出现在对应栏目；未映射的列（如身体状态 21）在这里可核对
  const legacyKeys = Object.keys(legacyCols);
  if (legacyKeys.length) col('legacy', 'Mortal 原始列', (
    <>
      <div className="hint" style={{ marginBottom: 6 }}>
        未映射的列按原列号留档于此；已识别的列已同步到对应栏目。
      </div>
      {Object.entries(legacyCols).map(([col_, val]) => (
        <div className="kv" key={col_}>
          <span className="k" style={{ fontSize: 12 }}>{NPC_COLUMN_LABELS[col_] || `第 ${col_} 列`}</span>
          <span className="v" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {typeof val === 'string' ? val : JSON.stringify(val)}
          </span>
        </div>
      ))}
    </>
  ), legacyKeys.length);

  if (snap.portraitPrompt || editable) col('portrait', '肖像提示词', (
    <Ekv label="portraitPrompt" value={snap.portraitPrompt} editable={editable} onPatch={onPatch} path="portraitPrompt" area />
  ));

  // concurrent-evo-preset 扩展字段
  if (Array.isArray(snap.spiritBeasts) && snap.spiritBeasts.length > 0) col('beasts', '灵兽', (
    <>
      {snap.spiritBeasts.map((b, i) => (
        <div className="kv" key={i}><span className="k" style={{ fontSize: 12 }}>{T(b.name, '?')}</span><span className="v" style={{ fontSize: 12 }}>{T(b.realm)} · {T(b.species)}</span></div>
      ))}
    </>
  ), snap.spiritBeasts.length);

  if (snap.techniqueMasteries && typeof snap.techniqueMasteries === 'object' && !Array.isArray(snap.techniqueMasteries) && Object.keys(snap.techniqueMasteries).length > 0) {
    const tm = Object.entries(snap.techniqueMasteries);
    col('mastery', '功法熟练度', (
      <>
        {tm.map(([k, v]) => (
          <div className="kv" key={k}><span className="k" style={{ fontSize: 12 }}>{k}</span><span className="v" style={{ fontSize: 12 }}>{T(v.level || v.tier || v)}</span></div>
        ))}
      </>
    ), tm.length);
  }

  if (snap.lifespanRoll) col('lifespan', '寿元推算', (
    <>
      <div className="kv"><span className="k">基准境界</span><span className="v">{T(snap.lifespanRoll.majorRealm, '—')}</span></div>
      <div className="kv"><span className="k">基准寿元</span><span className="v">{snap.lifespanRoll.baseShouyuan ?? '—'}</span></div>
      {snap.lifespanRoll.zScore != null && <div className="kv"><span className="k">Z 值</span><span className="v">{snap.lifespanRoll.zScore}</span></div>}
    </>
  ));

  if (snap.factionAffiliation) col('faction', '门派归属', (
    <>
      <div className="kv"><span className="k">门派</span><span className="v">{T(snap.factionAffiliation.factionId, '—')}</span></div>
      <div className="kv"><span className="k">身份</span><span className="v">{T(snap.factionAffiliation.status, '—')}</span></div>
      {snap.factionAffiliation.memberRank && <div className="kv"><span className="k">职衔</span><span className="v">{T(snap.factionAffiliation.memberRank)}</span></div>}
    </>
  ));

  // 「主角专属」栏（善恶值 / 心魔值 / 进度 / 绿瓶 / 死亡次数）已于 2026-09-22 按玩家要求整体删除，
  // 对应字段一并废弃（见 snapshotSchema 的 makeEmptySnapshot）。其中「进度」并入上方「身份」栏的「境界进度」。

  if (snap.adult) col('adult', '成人字段', (
    <>
      {snap.adult.desire != null && <div className="kv"><span className="k">欲念</span><span className="v">{snap.adult.desire}</span></div>}
      {snap.adult.pleasure != null && <div className="kv"><span className="k">愉悦</span><span className="v">{snap.adult.pleasure}</span></div>}
      {(snap.adult.sensitiveTraits || []).length > 0 && <div className="kv"><span className="k">敏感特质</span><span className="v" style={{ fontSize: 12 }}>{snap.adult.sensitiveTraits.map(x => T(x)).filter(Boolean).join('、')}</span></div>}
    </>
  ));

  // 本轮演化指令（concurrent 预设 tagged 桥接产物，字符串或数组皆可）
  const toLines = v => !v ? [] : Array.isArray(v) ? v.filter(Boolean).map(String) : String(v).split('\n').filter(Boolean);
  const stateLines = toLines(snap.stateCommands);
  const upstoreLines = toLines(snap.upstoreCommands);
  if (stateLines.length || upstoreLines.length) col('commands', '本回合剧情记录', (
    <>
      {stateLines.length > 0 && (
        <div className="kv"><span className="k">state · {stateLines.length}</span>
          <span className="v" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{stateLines.join('\n')}</span></div>
      )}
      {upstoreLines.length > 0 && (
        <div className="kv"><span className="k">upstore · {upstoreLines.length}</span>
          <span className="v" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{upstoreLines.join('\n')}</span></div>
      )}
    </>
  ), stateLines.length + upstoreLines.length);

  const cur = cols.find(c => c.key === activeCol) || cols[0];

  return (
    <div className="snapshot-view">
      <datalist id="inv-type-list">{INV_ITEM_TYPES.map(t => <option key={t} value={t} />)}</datalist>
      <datalist id="inv-subtype-list2">{INV_SUBTYPE_CANDIDATES.map(s => <option key={s} value={s} />)}</datalist>
      <datalist id="inv-grade-list2">{INV_GRADE_CANDIDATES.map(g => <option key={g} value={g} />)}</datalist>
      <datalist id="trait-rarity-list">{TRAIT_RARITIES.map(r => <option key={r.name} value={r.name} />)}</datalist>

      <div className="snapshot-cols" role="tablist" aria-label="快照栏目">
        {cols.map(c => (
          <button key={c.key} type="button" role="tab" aria-selected={c.key === cur.key}
            className={`snapshot-col-btn${c.key === cur.key ? ' active' : ''}`}
            onClick={() => setActiveCol(c.key)}>
            {c.label}
            {c.badge != null && c.badge !== '' ? <span className="snapshot-col-badge">{c.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="snapshot-pane card" role="tabpanel" aria-label={cur.label}>
        <h4 className="snapshot-pane-title">{cur.label}</h4>
        {cur.node}
      </div>

      {editable && addOpen && <ItemAddModal onAdd={addInvItem} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
