import React, { useState } from 'react';
import { computeAttrs, rootDisplayName, ATTR_KEYS, normalizeDims } from '../data/gameData.js';
import PersonalityDims from '../components/PersonalityDims.jsx';

const TABS = ['基本信息', '属性', '技能', '特质', '性格', '经历'];

// 角色详情（多 Tab，还原原站结构；肖像/隐秘等与生图相关 Tab 不保留）
export default function CharacterDetail({ save }) {
  const [tab, setTab] = useState(0);
  const c = save.character;
  const attrs = computeAttrs(c);

  return (
    <div>
      <div className="tabs">
        {TABS.map((t, i) => <button key={t} className={i === tab ? 'active' : ''} onClick={() => setTab(i)}>{t}</button>)}
      </div>

      {tab === 0 && (
        <>
          <div className="kv"><span className="k">姓名</span><span className="v">{c.name}</span></div>
          <div className="kv"><span className="k">身份</span><span className="v">{c.origin?.name}</span></div>
          <div className="kv"><span className="k">性别</span><span className="v">{c.gender}</span></div>
          <div className="kv"><span className="k">种族</span><span className="v">{c.race?.name}</span></div>
          <div className="kv"><span className="k">境界</span><span className="v">{c.realm?.name}</span></div>
          <div className="kv"><span className="k">灵根</span><span className="v">{rootDisplayName(c.root)}</span></div>
          <div className="kv"><span className="k">年龄</span><span className="v">{c.age} 岁</span></div>
          <div className="kv"><span className="k">寿元</span><span className="v">约 {Math.max(0, (c.realm?.lifespan || 80) - c.age)} 年</span></div>
          <div className="kv"><span className="k">人称</span><span className="v">{c.person}</span></div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>外貌描写</label>
            <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{c.appearance || '未指定，将随剧情自然生成'}</div>
          </div>
          <div className="field">
            <label>所在地</label>
            <div className="hint">{save.world.location?.name}</div>
          </div>
        </>
      )}

      {tab === 1 && (
        <>
          {ATTR_KEYS.map(k => (
            <div className="attr-bar" key={k}>
              <span className="label">{k}</span>
              <div className="track"><div className="fill" style={{ width: `${Math.min(100, (attrs[k] / 150) * 100)}%` }} /></div>
              <span className="val">{attrs[k]}</span>
            </div>
          ))}
        </>
      )}

      {tab === 2 && (
        c.skills?.length ? (
          <div className="card-list">
            {c.skills.map(s => (
              <div className="card" key={s.name}>
                <div className="row1"><span className="name">{s.name}</span><span className="cost">{s.tier}</span></div>
                <div className="desc">{s.desc}</div>
              </div>
            ))}
          </div>
        ) : <div className="empty-tip">尚未习得任何技能</div>
      )}

      {tab === 3 && (
        c.traits?.length ? (
          <div className="card-list">
            {c.traits.map(t => (
              <div className="card" key={t.name}>
                <div className="row1"><span className="name">{t.name}</span></div>
                <div className="desc">{t.desc}</div>
              </div>
            ))}
          </div>
        ) : <div className="empty-tip">尚未觉醒任何先天气运</div>
      )}

      {tab === 4 && (
        <>
          <PersonalityDims dims={normalizeDims(c.personality?.dims)} readOnly />
          <div className="hint" style={{ marginTop: 8 }}>鼠标悬停可查看每个维度的含义。</div>
          {c.personality?.scenarios?.length > 0 && (
            <div className="section" style={{ marginTop: 16 }}>
              <h4>情境问答</h4>
              {c.personality.scenarios.map((s, i) => (
                <div className="card" key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                  <div>{SCENARIO_TEXT(c, i)}</div>
                  {(s.say || s.act) && (
                    <div style={{ marginTop: 6, color: 'var(--gold-dim)' }}>
                      {s.say && <div>言：「{s.say}」</div>}
                      {s.act && <div>行：{s.act}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 5 && (
        save.story?.length ? (
          <div className="card-list">
            {save.story.map((b, i) => (
              <div className="card" key={i} style={{ fontSize: 13 }}>
                <div style={{ color: 'var(--text-faint)', marginBottom: 4 }}>第 {b.turn} 节 · {b.timeLabel}</div>
                <div style={{ whiteSpace: 'pre-wrap', color: b.role === 'user' ? 'var(--blue)' : 'var(--text)' }}>{b.text}</div>
              </div>
            ))}
          </div>
        ) : <div className="empty-tip">经历尚是一片空白</div>
      )}
    </div>
  );
}

// 从 gameData 中读取情境原文（避免循环依赖，此处通过存档记录的顺序还原）
import { SCENARIOS } from '../data/gameData.js';
function SCENARIO_TEXT(save, i) { return SCENARIOS[i]?.text || '情境文本缺失'; }
