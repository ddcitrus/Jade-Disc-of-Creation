import React, { useState, useMemo } from 'react';
import {
  DIFFICULTIES, ORIGINS, RACES, TRAITS, TRAIT_RARITIES, SKILLS, ITEMS,
  ROOT_TYPES, ROOT_CULTIVATE_RATE, REALMS, WORLD_FACTORS, PERSONALITY_TEMPLATES,
  centeredDims, personalityTraits, SCENARIOS, GENDERS, PERSONS, LOCATIONS, ATTR_KEYS, SPENDABLE_ATTRS, BASE_ATTRS, traitCost, computeAttrs, rootDisplayName
} from '../data/gameData.js';
import { buildSave } from '../saveModel.js';
import { api } from '../api.js';
import ModTags from '../components/ModTags.jsx';
import PersonalityDims from '../components/PersonalityDims.jsx';
import { useToast, Spinner } from '../ui.jsx';

const STEPS = ['难度', '属性与出身', '性别与种族', '主角性格', '初始内容', '灵根', '世界因子', '最终确认'];

export default function CreateWizard({ settings, onCreated, onBack }) {
  const [step, setStep] = useState(0);
  const toast = useToast();
  // 难度
  const [difficulty, setDifficulty] = useState(DIFFICULTIES[1]);
  // 属性与出身
  const [alloc, setAlloc] = useState({});
  const [origin, setOrigin] = useState(null);
  // 性别与种族
  const [charName, setCharName] = useState('');
  const [age, setAge] = useState(18);
  const [gender, setGender] = useState('男性');
  const [appearance, setAppearance] = useState('');
  const [person, setPerson] = useState(PERSONS[1]);
  const [realm, setRealm] = useState(REALMS[0]);
  const [race, setRace] = useState(null);
  // 性格
  const [persTemplate, setPersTemplate] = useState(null);
  const [persDims, setPersDims] = useState(centeredDims);
  const [scenarios, setScenarios] = useState(() => SCENARIOS.map(() => ({ on: true, say: '', act: '' })));
  // 初始内容
  const [tab, setTab] = useState('traits');
  const [traits, setTraits] = useState([]);
  const [skills, setSkills] = useState([]);
  const [items, setItems] = useState([]);
  // 灵根
  const [root, setRoot] = useState(null);
  // 世界因子
  const [factors, setFactors] = useState([]);
  // 最终确认
  const [saveName, setSaveName] = useState('');
  const [location, setLocation] = useState(null);
  const [startTime, setStartTime] = useState([1, 1, 1, 8, 0]);
  const [background, setBackground] = useState('');
  const [hook, setHook] = useState('');

  // 点数计算
  const points = useMemo(() => {
    let used = realm.cost + (origin?.cost || 0) + (race?.cost || 0) + (root?.cost || 0);
    for (const t of traits) used += traitCost(t);
    used += Object.values(alloc).reduce((a, b) => a + b, 0);
    return difficulty.points - used;
  }, [difficulty, realm, origin, race, root, traits, alloc]);

  const canNext = useMemo(() => {
    switch (step) {
      case 0: return !!difficulty;
      case 1: return !!origin;
      case 2: return !!race && charName.trim().length > 0;
      case 3: return true;
      case 4: return true;
      case 5: return !!root;
      case 6: return true;
      case 7: return saveName.trim().length > 0 && !!location;
      default: return false;
    }
  }, [step, difficulty, origin, race, charName, root, saveName, location]);

  const toggleTrait = (t) => {
    setTraits(list => {
      const i = list.findIndex(x => x.name === t.name);
      if (i >= 0) return list.filter(x => x.name !== t.name);
      if (list.length >= 5) { toast('err', '先天气运最多选择 5 条'); return list; }
      if (points < traitCost(t)) { toast('err', '剩余点数不足'); return list; }
      return [...list, t];
    });
  };

  const startLife = () => {
    const wizard = {
      difficulty, alloc, origin, charName: charName.trim(), age, gender, appearance,
      person, realm, race, traits, skills, items,
      personality: { dims: persDims, scenarios: scenarios.filter(s => s.on) },
      root, worldFactors: factors, saveName: saveName.trim(), location,
      startTime, background, hook
    };
    // 初始快照按创建选择固定格式模板直生成（buildSave → snapshotFromCharacter），不经 AI：
    // 界面选了火灵根，快照 identity.linggen 就是火灵根，杜绝 AI 幻觉改写
    const save = buildSave(wizard, settings);
    onCreated(save);
  };

  const allocAttr = (k, d) => {
    setAlloc(a => {
      const cur = a[k] || 0;
      const next = cur + d;
      if (next < 0) return a;
      if (d > 0 && points < 1) return a;
      return { ...a, [k]: next };
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      <div className="top-bar">
        <button className="ghost small" onClick={onBack}>返回主页</button>
        <h1>角色创建</h1>
      </div>
      <div className="step-nav">
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={i === step ? 'current' : i < step ? 'done' : ''}
            disabled={i > step}
            onClick={() => i < step && setStep(i)}
          >{i < step ? `返回${s}` : i === step ? s : s}</button>
        ))}
      </div>

      <div className="wizard-page">
        {step === 0 && (
          <div className="section">
            <h3>选择难度</h3>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>难度决定你可用的创建点数与奇遇倾向。</p>
            <div className="card-grid">
              {DIFFICULTIES.map(d => (
                <div key={d.id} role="button" tabIndex={0} className={`card selectable ${difficulty?.id === d.id ? 'selected' : ''}`} onClick={() => setDifficulty(d)}>
                  <div className="row1"><span className="name">{d.name}</span><span className="cost">{d.points} 点</span></div>
                  <div className="desc">{d.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <>
            <div className="section">
              <h3>属性分配 · 剩余 {points} 点，1 点 = +1 属性</h3>
              <div style={{ maxWidth: 520 }}>
                {SPENDABLE_ATTRS.map(k => (
                  <div className="kv" key={k} style={{ alignItems: 'center', padding: '4px 0' }}>
                    <span className="k">{k} · 基础 {BASE_ATTRS[k]}{alloc[k] ? ` + ${alloc[k]}` : ''}</span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button className="small" onClick={() => allocAttr(k, -1)}>−</button>
                      <span style={{ width: 28, textAlign: 'center', color: 'var(--gold-dim)' }}>{alloc[k] || 0}</span>
                      <button className="small" onClick={() => allocAttr(k, 1)}>＋</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="section">
              <h3>出身选择</h3>
              <div className="card-grid">
                {ORIGINS.map(o => (
                  <div key={o.id}
                    role="button" tabIndex={0} className={`card selectable ${origin?.id === o.id ? 'selected' : ''} ${o.cost > points + (origin?.cost || 0) ? 'disabled-card' : ''}`}
                    onClick={() => { if (o.cost <= points + (origin?.cost || 0)) setOrigin(o); else toast('err', '剩余点数不足'); }}>
                    <div className="row1"><span className="name">{o.name}</span><span className="cost">{o.cost}点</span></div>
                    <div className="desc">{o.desc}</div>
                    <ModTags mods={o.mods} />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="section">
              <h3>角色设定</h3>
              <div className="char-summary">
                <div className="col">
                  <div className="field">
                    <label>角色名 *</label>
                    <input type="text" value={charName} onChange={e => setCharName(e.target.value)} placeholder="道友的名讳…" />
                    <div className="hint">命名规则：建议 2-6 个汉字，符合修仙世界观的姓名或道号。</div>
                  </div>
                  <div className="field">
                    <label>初始年龄</label>
                    <input type="number" min="8" max="60" value={age} onChange={e => setAge(Number(e.target.value) || 18)} />
                  </div>
                  <div className="field">
                    <label>性别外貌</label>
                    <div className="btn-row">
                      {GENDERS.map(g => (
                        <button key={g} className={gender === g ? 'primary' : ''} onClick={() => setGender(g)}>{g}</button>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>人称</label>
                    <div className="btn-row">
                      {PERSONS.map(p => (
                        <button key={p} className={person === p ? 'primary' : ''} onClick={() => setPerson(p)}>{p}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="col">
                  <div className="field">
                    <label>主角外貌描写</label>
                    <textarea value={appearance} onChange={e => setAppearance(e.target.value)} placeholder="留空时，后续剧情会按当前设定自然生成…" />
                  </div>
                  <div className="field">
                    <label>初始境界</label>
                    <select value={realm.name} onChange={e => {
                      const r = REALMS.find(x => x.name === e.target.value);
                      if (r.cost > points + realm.cost) { toast('err', '剩余点数不足'); return; }
                      setRealm(r);
                    }}>
                      {REALMS.map(r => <option key={r.name} value={r.name}>{r.name} · {r.cost}点 · 寿元约{r.lifespan}年</option>)}
                    </select>
                    <div className="hint">{realm.desc} 境界会影响开局的气血、法力和攻防等基础表现；实际剩余寿元会按初始年龄结算。</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="section">
              <h3>种族选择</h3>
              <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {RACES.map(r => (
                  <div key={r.name}
                    role="button" tabIndex={0} className={`card selectable ${race?.name === r.name ? 'selected' : ''} ${r.cost > points + (race?.cost || 0) ? 'disabled-card' : ''}`}
                    onClick={() => { if (r.cost <= points + (race?.cost || 0)) setRace(r); else toast('err', '剩余点数不足'); }}>
                    <div className="row1"><span className="name">{r.name}</span><span className="cost">{r.cost}点</span></div>
                    <div className="desc">{r.desc}</div>
                    <ModTags mods={r.mods} />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="section">
              <h3>主角性格</h3>
              <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>
                这会作为主角初始性格写入当前存档。先选一个接近的内核，模板不消耗点数。
              </p>
              <div className="btn-row">
                <button onClick={() => setPersTemplate(null)}>暂不设定</button>
              </div>
              <div className="card-grid">
                {PERSONALITY_TEMPLATES.map(t => (
                  <div key={t.name} role="button" tabIndex={0} className={`card selectable ${persTemplate?.name === t.name ? 'selected' : ''}`}
                    onClick={() => {
                      setPersTemplate(t);
                      setPersDims({ ...centeredDims(), ...t.dims });
                    }}>
                    <div className="row1"><span className="name">{t.name}</span></div>
                    <div className="desc">
                      {personalityTraits(t.dims).map(x => <span key={x.side} className="tag">{x.side} {x.value}/6</span>)}
                      <div>{t.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="section">
              <h3>细调性格维度</h3>
              <div className="hint" style={{ marginBottom: 8 }}>偏哪一侧，哪一侧的名字就会加粗；3 为居中。鼠标悬停可看每个维度的含义。</div>
              <PersonalityDims dims={persDims} onChange={(key, v) => setPersDims(d => ({ ...d, [key]: v }))} showDesc />
            </div>
            <div className="section">
              <h3>情境问答 · 可选，回答越具体言行越一致</h3>
              {SCENARIOS.map((sc, i) => (
                <div className="card" key={i} style={{ marginBottom: 10, opacity: scenarios[i].on ? 1 : 0.5 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" checked={scenarios[i].on}
                      onChange={e => setScenarios(list => list.map((x, j) => j === i ? { ...x, on: e.target.checked } : x))} />
                    <span style={{ fontSize: 13 }}>{sc.text}</span>
                  </label>
                  {scenarios[i].on && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                      <input type="text" placeholder="角色会说的话…" value={scenarios[i].say}
                        onChange={e => setScenarios(list => list.map((x, j) => j === i ? { ...x, say: e.target.value } : x))} />
                      <input type="text" placeholder="角色会做的事…" value={scenarios[i].act}
                        onChange={e => setScenarios(list => list.map((x, j) => j === i ? { ...x, act: e.target.value } : x))} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="section">
              <h3>初始内容</h3>
              <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>特质沿用创建点数；技能和物品不消耗特质点。</p>
              <div className="tabs">
                <button className={tab === 'traits' ? 'active' : ''} onClick={() => setTab('traits')}>特质 <span className="tab-cnt">{traits.length}/5</span></button>
                <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>技能 <span className="tab-cnt">{skills.length}</span></button>
                <button className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>物品 <span className="tab-cnt">{items.length}</span></button>
              </div>

              {tab === 'traits' && (
                <>
                  <div className="btn-row">
                    <button onClick={() => {
                      // 随机抽取：从点数允许的词条中随机抽1条
                      const pool = TRAITS.filter(t => !traits.find(x => x.name === t.name) && traitCost(t) <= points);
                      if (!pool.length) return toast('err', '没有可抽的词条了');
                      if (traits.length >= 5) return toast('err', '先天气运最多 5 条');
                      toggleTrait(pool[Math.floor(Math.random() * pool.length)]);
                    }}>随机抽取</button>
                    <span style={{ fontSize: 13, color: 'var(--text-faint)', alignSelf: 'center' }}>手动按稀有度计费。</span>
                  </div>
                  {TRAIT_RARITIES.map(r => (
                    <div key={r.id} style={{ marginBottom: 16 }}>
                      <h4 style={{ marginBottom: 8 }}>{r.name} · {TRAITS.filter(t => t.rarity === r.id).length} 个 · {r.cost} 点/个</h4>
                      <div className="card-grid">
                        {TRAITS.filter(t => t.rarity === r.id).map(t => (
                          <div key={t.name} role="button" tabIndex={0} className={`card selectable ${traits.find(x => x.name === t.name) ? 'selected' : ''}`} onClick={() => toggleTrait(t)}>
                            <div className="row1"><span className="name">{t.name}</span><span className="cost">{traitCost(t)}点</span></div>
                            <div className="desc">{t.desc}</div>
                            <ModTags mods={t.mods} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {tab === 'skills' && (
                <>
                  <h4 style={{ marginBottom: 8 }}>选择开局技能 · 默认直接习得</h4>
                  <div className="card-grid">
                    {SKILLS.map(s => (
                      <div key={s.name} role="button" tabIndex={0} className={`card selectable ${skills.find(x => x.name === s.name) ? 'selected' : ''}`}
                        onClick={() => setSkills(list => list.find(x => x.name === s.name) ? list.filter(x => x.name !== s.name) : [...list, s])}>
                        <div className="row1"><span className="name">{s.name}</span><span className="cost">{s.tier}</span></div>
                        <div className="desc">{s.desc}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === 'items' && (
                <>
                  <h4 style={{ marginBottom: 8 }}>选择开局物品 · 可选多件并设置数量</h4>
                  <div className="card-grid">
                    {ITEMS.map(it => {
                      const sel = items.find(x => x.name === it.name);
                      return (
                        <div key={it.name} role="button" tabIndex={0} className={`card selectable ${sel ? 'selected' : ''}`}
                          onClick={() => setItems(list => sel ? list.filter(x => x.name !== it.name) : [...list, { ...it, count: 1 }])}>
                          <div className="row1"><span className="name">{it.name}</span><span className="cost">{it.type}</span></div>
                          <div className="desc">{it.desc}</div>
                          {sel && (
                            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>数量</span>
                              <button className="small" onClick={() => setItems(list => list.map(x => x.name === it.name ? { ...x, count: Math.max(1, x.count - 1) } : x))}>−</button>
                              <span style={{ color: 'var(--gold-dim)' }}>{sel.count}</span>
                              <button className="small" onClick={() => setItems(list => list.map(x => x.name === it.name ? { ...x, count: x.count + 1 } : x))}>＋</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {step === 5 && (
          <div className="section">
            <h3>灵根选择</h3>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>
              灵根决定了你修炼的亲和属性和潜力。天灵根最强但最贵，无灵根不花点数但修炼艰难。
            </p>
            {root ? (
              <div className="notice" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>当前灵根：<b style={{ color: 'var(--gold)' }}>{rootDisplayName(root)}</b>· 消耗{root.cost}点 · 修炼速度 {Math.round(ROOT_CULTIVATE_RATE[root.typeId] * 100)}%）</span>
                <button className="small" onClick={() => setRoot(null)}>重选</button>
              </div>
            ) : (
              <div className="btn-row">
                <button onClick={() => {
                  // 随机灵根：按权重随机
                  const pool = [
                    { w: 5, make: () => ({ typeId: 'heaven', typeName: '天灵根', elements: [pick(['金', '木', '水', '火', '土'])], cost: 50 }) },
                    { w: 5, make: () => ({ typeId: 'variant', typeName: '异灵根', elements: [pick(['冰', '风', '雷', '暗'])], cost: 50 }) },
                    { w: 25, make: () => ({ typeId: 'true', typeName: '真灵根', elements: pickN(['金', '木', '水', '火', '土'], 2 + Math.floor(Math.random() * 2)), cost: 20 }) },
                    { w: 60, make: () => ({ typeId: 'pseudo', typeName: '伪灵根', elements: pickN(['金', '木', '水', '火', '土'], 4 + Math.floor(Math.random() * 2)), cost: 2 }) },
                  ];
                  const total = pool.reduce((a, p) => a + p.w, 0);
                  let r = Math.random() * total, chosen = pool[0];
                  for (const p of pool) { r -= p.w; if (r <= 0) { chosen = p; break; } }
                  setRoot({ ...chosen.make() });
                }}>随机灵根 · 本次免费</button>
                <span style={{ fontSize: 12, color: 'var(--text-faint)', alignSelf: 'center' }}>随机池只会生成当前规则允许的组合。</span>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginBottom: 8 }}>自选灵根</h4>
              <div className="card-grid">
                {ROOT_TYPES.map(rt => (
                  <RootCard key={rt.id} rt={rt} points={points} root={root}
                    onPick={(elements, customName) => setRoot({ typeId: rt.id, typeName: rt.name, elements, cost: rt.cost, customName })} />
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="section">
            <h3>世界因子</h3>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>
              可选的世界规则变动。不选也完全没问题，选了会改变整个世界的基调。
            </p>
            <div className="card-grid">
              {WORLD_FACTORS.map(f => (
                <div key={f.name} role="button" tabIndex={0} className={`card selectable ${factors.find(x => x.name === f.name) ? 'selected' : ''}`}
                  onClick={() => setFactors(list => list.find(x => x.name === f.name) ? list.filter(x => x.name !== f.name) : [...list, f])}>
                  <div className="row1"><span className="name">{f.name}</span></div>
                  <div className="desc">{f.desc}</div>
                  <div className="desc" style={{ color: 'var(--gold-dim)' }}>效果：{f.effect}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 7 && (
          <>
            <div className="section">
              <h3>最终确认 · 剩余点数 {points}</h3>
              <div className="char-summary">
                <div className="col">
                  <div className="field">
                    <label>存档名称 *</label>
                    <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="为这段人生命名…" />
                  </div>
                  <div className="field">
                    <label>出生地点 *</label>
                    <div className="btn-row">
                      <button onClick={() => setLocation(LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)])}>随机地点</button>
                      {location && <span className="tag" style={{ color: 'var(--gold-dim)' }}>{location.name}</span>}
                    </div>
                    {location && <div className="hint">{location.desc} · 灵气浓度 {location.aura}</div>}
                  </div>
                  <div className="field">
                    <label>开局时间 *</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {['年', '月', '日', '时', '分'].map((u, i) => (
                        <span key={u} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <input type="number" min="1" value={startTime[i]}
                            onChange={e => setStartTime(t => t.map((x, j) => j === i ? (Number(e.target.value) || 1) : x))} style={{ width: 70 }} />
                          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{u}</span>
                        </span>
                      ))}
                    </div>
                    <div className="hint">开局时间：{startTime[0]}年{startTime[1]}月{startTime[2]}日 {String(startTime[3]).padStart(2, '0')}:{String(startTime[4]).padStart(2, '0')}</div>
                  </div>
                  <div className="field">
                    <label>开局背景 <span className="lbl-note">可选</span></label>
                    <textarea value={background} onChange={e => setBackground(e.target.value)} placeholder="描述故事发生前的背景…" />
                  </div>
                  <div className="field">
                    <label>开局钩子 <span className="lbl-note">可选</span></label>
                    <textarea value={hook} onChange={e => setHook(e.target.value)} placeholder="一个悬而未决的引子，牵引剧情展开…" />
                  </div>
                </div>
                <div className="col">
                  <div className="card">
                    <h3 style={{ marginBottom: 8 }}>{charName || '未命名'}</h3>
                    <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4 }}>{gender} · {race?.name} · {origin?.name} · {realm?.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--gold-dim)', marginBottom: 10 }}>难度 · {difficulty.name}　灵根 · {root ? rootDisplayName(root) : '未定'}</div>
                    <div className="kv"><span className="k">出生地点</span><span className="v">{location?.name || '未选择'}</span></div>
                    <div className="kv"><span className="k">开局时间</span><span className="v">{startTime[0]}年{startTime[1]}月{startTime[2]}日</span></div>
                    <div className="kv"><span className="k">人称</span><span className="v">{person}</span></div>
                    <div className="kv"><span className="k">初始年龄</span><span className="v">{age}岁</span></div>
                    <div className="kv"><span className="k">主角性格</span><span className="v">{persTemplate?.name || '暂不设定'}</span></div>
                    <div className="kv"><span className="k">特质</span><span className="v">{traits.length ? traits.map(t => t.name).join('、') : '尚未选择'}</span></div>
                    <div className="kv"><span className="k">技能</span><span className="v">{skills.length ? skills.map(s => s.name).join('、') : '尚未选择'}</span></div>
                    <div className="kv"><span className="k">物品</span><span className="v">{items.length ? items.map(i => `${i.name}×${i.count}`).join('、') : '尚未选择'}</span></div>
                    <div className="kv"><span className="k">世界因子</span><span className="v">{factors.length ? factors.map(f => f.name).join('、') : '未选择'}</span></div>
                  </div>
                  <div className="card" style={{ marginTop: 10 }}>
                    <h4 style={{ marginBottom: 8 }}>属性总览</h4>
                    {(() => {
                      const attrs = computeAttrs({ origin, race, traits, alloc });
                      return ATTR_KEYS.map(k => (
                        <div className="kv" key={k}><span className="k">{k}</span><span className="v" style={{ color: 'var(--gold-dim)' }}>{attrs[k]}</span></div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="wizard-footer">
        <button onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>上一步</button>
        <span className="points">剩余点数: {points}</span>
        {step < 7 ? (
          <button className="primary" disabled={!canNext} onClick={() => canNext && setStep(step + 1)}>下一步</button>
        ) : (
          <button className="primary" disabled={!canNext} onClick={startLife}>
            开始人生
          </button>
        )}
      </div>
    </div>
  );
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }

// 灵根选择卡
function RootCard({ rt, points, root, onPick }) {
  const [sel, setSel] = useState([]);
  const [customName, setCustomName] = useState('');
  const isCustom = rt.id === 'custom';
  const min = Array.isArray(rt.count) ? rt.count[0] : rt.count;
  const max = Array.isArray(rt.count) ? rt.count[1] : rt.count;
  const ok = rt.id === 'none' || (isCustom ? customName.trim().length > 0 && sel.length > 0 : sel.length >= min && sel.length <= max);

  return (
    <div className="card">
      <div className="row1"><span className="name">{rt.name}</span><span className="cost">{rt.id === 'none' ? '无需属性' : `${min === max ? min : `${min}-${max}`}属性 · ${rt.cost}点起`}</span></div>
      <div className="desc">{rt.desc}</div>
      {rt.elements.length > 0 && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {rt.elements.map(el => (
            <button key={el} className={`small ${sel.includes(el) ? 'primary' : ''}`}
              onClick={() => setSel(list => {
                if (list.includes(el)) return list.filter(x => x !== el);
                if (max && list.length >= max) return list;
                return [...list, el];
              })}>{el}</button>
          ))}
        </div>
      )}
      {isCustom && (
        <input type="text" style={{ marginTop: 8, width: '100%' }} placeholder="灵根命名…" value={customName} onChange={e => setCustomName(e.target.value)} />
      )}
      {rt.id !== 'none' && (
        <div className="hint" style={{ marginTop: 6 }}>
          {sel.length === 0 ? '先点选属性。' : `已选 ${sel.length} 个${max && sel.length >= min ? ` · 将生成：${rt.name} ${sel.join('')}` : ` · 还需 ${min - sel.length} 个`}`}
        </div>
      )}
      <button className="small primary" style={{ marginTop: 8, width: '100%' }}
        disabled={!ok || rt.cost > points}
        onClick={() => onPick(isCustom ? [...sel] : (rt.id === 'none' ? [] : [...sel]), customName)}>
        使用该灵根
      </button>
    </div>
  );
}
