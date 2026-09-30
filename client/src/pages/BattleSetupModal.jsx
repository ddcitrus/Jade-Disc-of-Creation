import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { unitFromSnapshot, buildBattleFromSpec } from '../data/battleTrigger.js';

// ===== 手动开战：玩家自己挑参战人物 =====
// 「自动下回合」那一行的「⚔ 开战」弹的就是这个。
// 默认预填「主角打第一个 NPC」，玩家只要改改阵营就能开打 —— 不必等 AI 在正文里写 <battle>。
//
// 每个角色后面显示的气血，取自**真正建局那条路**（buildBattleFromSpec，纯函数、不写盘）：
// 建局时会按数值表给越界的角色校界，所以只有用它取数，才谈得上「这里写多少、进去打就是多少」。
// 直接用存档里的数字会穿帮 —— 实测主角存档自身 880/891，而战斗里真正用的是 32880/32891（含特质装备）。
export default function BattleSetupModal({ save, settings, onStart, onClose, busy = false }) {
  // 兜底显示用（建局没跑出结果时）：与战斗同口径的生效值
  const chars = useMemo(() => {
    const snaps = save?.charSnapshots || {};
    const list = Object.keys(snaps).map(id => {
      const snap = snaps[id];
      let u = null;
      try { u = unitFromSnapshot(save, snap, { id }); } catch { u = null; }
      const idt = snap?.identity || {};
      return {
        id,
        name: idt.name || u?.name || id,
        realm: idt.realm || u?.realm || '',
        hp: u?.hp ?? 0,
        hpMax: u?.hpMax ?? 0,
        isPlayer: id === 'B1',
      };
    });
    // 主角置顶，其余保持存档里的顺序
    return list.sort((a, b) => (a.isPlayer === b.isPlayer ? 0 : (a.isPlayer ? -1 : 1)));
  }, [save]);

  const [picks, setPicks] = useState(() => {
    const init = {};
    const me = chars.find(c => c.isPlayer) || chars[0];
    if (me) init[me.id] = 'left';
    const foe = chars.find(c => c.id !== me?.id);
    if (foe) init[foe.id] = 'right';
    return init;
  });
  const [deathmatch, setDeathmatch] = useState(false);
  const [note, setNote] = useState('');
  const [launching, setLaunching] = useState(false);
  // 试建的一局（只为取数显示，不落盘、不保留状态）
  const [probe, setProbe] = useState(null);

  const specOf = useCallback((picks) => {
    const pack = c => ({ id: c.id, side: picks[c.id], name: c.name, realm: c.realm });
    return {
      units: [
        ...chars.filter(c => picks[c.id] === 'left').map(pack),
        ...chars.filter(c => picks[c.id] === 'right').map(pack),
      ],
    };
  }, [chars]);

  // 选人一变就试建一次局：拿到的手感数字（含校界后的值）与真正开战时同一份实现
  useEffect(() => {
    if (chars.length < 2) { setProbe(null); return; }
    const spec = specOf(picks);
    if (!spec.units.length) { setProbe(null); return; }
    try {
      const r = buildBattleFromSpec(save, spec, { tuning: settings?.numericTuning });
      setProbe(r && r.ok ? r : null);
    } catch { setProbe(null); }
  }, [picks, specOf, chars.length, save, settings]);

  const toggle = (id, side) => setPicks(p => {
    const next = { ...p };
    if (next[id] === side) delete next[id]; else next[id] = side;
    return next;
  });

  const left = chars.filter(c => picks[c.id] === 'left');
  const right = chars.filter(c => picks[c.id] === 'right');
  const ready = left.length > 0 && right.length > 0;
  const clampedN = probe ? Object.keys(probe.clamped || {}).length : 0;

  // 建局要写几次盘（校界/兜底档案），期间别让玩家连点第二次
  const start = async () => {
    if (!ready || busy || launching) return;
    setLaunching(true);
    try {
      await onStart({
        kind: deathmatch ? 'deathmatch' : 'normal',
        ...specOf(picks),
        note: note.trim(),
      });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={ev => ev.target === ev.currentTarget && onClose()}>
      <div className="modal battle-setup-modal" role="dialog" aria-modal="true" aria-label="选择参战人物">
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>⚔ 选择参战人物</h3>
          <button className="ghost small" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          {chars.length < 2 ? (
            <p className="bs-hint">
              存档里只有 {chars.length} 个角色，凑不出两边。先去「查看人物」里让 AI 建档，或等剧情里遇到人。
            </p>
          ) : (
            <>
              <p className="bs-hint">
                点每行右侧的「我方 / 敌方」把人放进阵营，再点一下取消。两边各至少一人即可开打
                —— 不需要等 AI 在正文里安排战斗。下面写的气血就是进战斗后用的数字。
              </p>
              <div className="bs-side-summary">
                <span><b>我方</b>{left.length ? left.map(c => c.name).join('、') : '（还没选）'}</span>
                <span><b>敌方</b>{right.length ? right.map(c => c.name).join('、') : '（还没选）'}</span>
              </div>
              <div className="bs-list">
                {chars.map(c => {
                  const side = picks[c.id];
                  const u = probe?.units?.find(x => x.id === c.id);
                  const hp = u ? u.hp : c.hp;
                  const hpMax = u ? u.hpMax : c.hpMax;
                  return (
                    <div key={c.id} className={`bs-row${side ? ' picked ' + side : ''}`}>
                      <div className="bs-who">
                        <span className="bs-name">
                          {c.name}{c.isPlayer && <em>主角</em>}
                        </span>
                        <span className="bs-meta">{c.realm || '境界未定'} · 气血 {hp}/{hpMax}</span>
                      </div>
                      <div className="bs-btns">
                        {/* 我方＝金/绿牌面、敌方＝红牌面：两行都选中时也一眼看得出谁打谁 */}
                        <button className={side === 'left' ? 'primary small' : 'ghost small'}
                          onClick={() => toggle(c.id, 'left')}>我方</button>
                        <button className={side === 'right' ? 'danger small' : 'ghost small'}
                          onClick={() => toggle(c.id, 'right')}>敌方</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {clampedN > 0 && (
                <p className="bs-hint bs-warn">
                  ⚠ 有 {clampedN} 个角色的属性超出数值表范围，上面已按数值表写回边界
                  —— 这就是他们进战斗后的数字。
                </p>
              )}
              <div className="bs-extra">
                <label className="bs-note">
                  开战缘由（可留空）
                  <input value={note} onChange={e => setNote(e.target.value)}
                    placeholder="会告诉 AI，比如：夺宝不成，当场翻脸" />
                </label>
                <label className="bs-death">
                  <input type="checkbox" checked={deathmatch} onChange={e => setDeathmatch(e.target.checked)} />
                  死斗（允许被打死）
                </label>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <span className="bs-foot-hint">
            {busy ? '正文生成中，等这一轮结束再开战'
              : (launching ? '正在校验人物、布置战场…'
                : (ready ? '' : '两边各选至少一人才能开战'))}
          </span>
          <button className="ghost small" onClick={onClose}>取消</button>
          <button className="danger small" disabled={!ready || busy || launching} onClick={start}>
            {launching ? '开战中…' : '开始战斗'}
          </button>
        </div>
      </div>
    </div>
  );
}
