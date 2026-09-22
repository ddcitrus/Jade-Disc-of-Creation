// ===== Mortal 正文渲染器 =====
// 把 AI 输出的语义标记渲染为 React 元素（不注入原始 HTML，天然防 XSS）：
// - ::dialogue 说话人|语气|称呼 或 ::dialogue {json} → 对话气泡（独立背景/边框，按语气着色）
// - ::scene/::jade/::bamboo/::aside/::thought/::focus/::break → 风格化段落
// - <ui_sys> → 开场状态栏
// - <scene_checkpoint> → 时空锚点胶囊
// - <cultivation_card>{json}</cultivation_card> → 修炼结算卡
// - <card> → 战斗推演卡（含卡面双方数据与回合日志）
// - <log> → 战斗回合日志（AI 漏写 <card> 外壳时的兜底；::log 前缀会被归一）
// - 结尾连续编号选项行 → 可点击按钮（点击复制文本到发送框）
// - 行内 [[item|xxx]] 等标记 → 高亮
import React, { useMemo } from 'react';
import { makeColorResolver } from '../data/colorPalette.js';
import { stripNewCharBlocks } from '../data/snapshotV2.js';

// ---- <font color=...> 支持 ----
// 世界书/预设常要求 AI 用 <font color='#DEC0FF'>…</font> 标注段落（酒馆会当 HTML 渲染成彩色）。
// 这里先转成哨兵标记，再由 renderInline 变成带颜色的 span：
// 既不外泄裸标签，也不会让标签行被当成块边界而把段落切开。
// 颜色是否放行由 colorPalette 决定：用户可在设置页限定"只能使用的颜色"。
const FONT_S = '\u0002'; // 哨兵：开标记 = \u0002<颜色>\u0003，关标记 = \u0002\u0003
const FONT_E = '\u0003';

function fontToMark(src, resolveColor) {
  return String(src || '')
    .replace(/<font\b([^>]*)>/gi, (m, attrs) => {
      const c = String(attrs).match(/color\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      return FONT_S + resolveColor(c ? (c[1] || c[2] || c[3]) : '') + FONT_E;
    })
    .replace(/<\/font\s*>/gi, FONT_S + FONT_E);
}

// 行内标记 [[type|text]] → 高亮 span；<font color> 段 → 着色 span
function renderInline(text, keyPrefix = '') {
  const parts = String(text || '').split(/(\[\[[a-zA-Z]+\|[^\]]*\]\]|\u0002[^\u0003]*\u0003)/g);
  const out = [];
  let color = '';
  parts.forEach((p, i) => {
    if (!p) return;
    if (p[0] === FONT_S) { color = p.length > 2 ? p.slice(1, -1) : ''; return; } // 开关当前颜色
    const key = keyPrefix + i;
    const m = p.match(/^\[\[([a-zA-Z]+)\|([^\]]*)\]\]$/);
    if (m) { out.push(<em className="mortal-inline" key={key} style={color ? { color } : undefined}>{m[2]}</em>); return; }
    out.push(color
      ? <span className="mortal-font" style={{ color }} key={key}>{p}</span>
      : <React.Fragment key={key}>{p}</React.Fragment>);
  });
  return out;
}

// 解析 ::dialogue 头：支持 "ID|tone|称呼" 与 JSON 两种格式
function parseDialogueHeader(line) {
  const rest = line.replace(/^::dialogue\s*/i, '').trim();
  if (rest.startsWith('{')) {
    try {
      const j = JSON.parse(rest);
      return { speaker: j.speaker || j.name || j.id || '？', tone: j.tone || '', id: j.id || '' };
    } catch { /* 回退竖线解析 */ }
  }
  const seg = rest.split('|').map(s => s.trim());
  if (seg.length >= 3) return { id: seg[0], tone: seg[1], speaker: seg[2] };
  if (seg.length === 2) return { id: seg[0], tone: seg[1], speaker: seg[0] === 'B1' ? '你' : (seg[0] || '？') };
  return { id: seg[0] || '', tone: '', speaker: seg[0] === 'B1' ? '你' : (seg[0] || rest || '？') };
}

const TONE_CLASS = {
  calm: 'tone-calm', warm: 'tone-warm', wary: 'tone-wary', austere: 'tone-austere',
  mist: 'tone-mist', omen: 'tone-omen', spirit: 'tone-spirit', injury: 'tone-injury', observe: 'tone-observe',
};

const BLOCK_CLASS = {
  scene: 'mortal-scene', jade: 'mortal-jade', bamboo: 'mortal-bamboo',
  aside: 'mortal-aside', thought: 'mortal-thought', focus: 'mortal-focus',
};

// 选项行识别：1. 【隐忍离去】 …… / 1、xxx
const OPT_LINE = /^\s*(\d{1,2})\s*[.、]\s*(.+)$/;
const OPT_DASH = /^\s*[-•·]\s+(.+)$/; // AI 有时用破折号/圆点列选项（实测：强敌又至回合）
// AI 还会把选项名写成 markdown 加粗：**【暗中布局】**：改变策略……
// （实测 2026-09-21 第 14 回合）不认这一种，整段就漏成正文，屏幕上留着生 asterisk。
const OPT_BOLD = /^\s*\*\*\s*(【[^】]+】)\s*\*\*\s*[：:]?\s*(.*)$/;
function unstarOption(t) {
  const m = String(t || '').trim().match(OPT_BOLD);
  return m ? (m[1] + m[2]).trim() : null;
}
// 统一的选项行匹配：编号或破折号，返回选项文本
function matchOptLine(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  const nm = t.match(OPT_LINE);
  if (nm) return unstarOption(nm[2]) || nm[2].trim();
  const dm = t.match(OPT_DASH);
  if (dm) return unstarOption(dm[1]) || dm[1].trim();
  const bm = unstarOption(t);
  if (bm) return bm;
  return null;
}

// ===== 战斗卡 / 战斗日志 =====
// AI 实际会写出三种形态，三种都要渲染，绝不允许把 <lm>/<lc>/<ld> 原文漏进正文：
//   ① 完整 <card>…</card>（协议要求的形态）
//   ② 裸 <log>…</log>（漏了卡片外壳）
//   ③ ::log 开头（误用语义标记前缀，已在预清理里归一成 ③ → <log>）
function stripInnerTags(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tagInner(src, tag) {
  const m = String(src || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}
function tagAll(src, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(String(src || '')))) out.push(m[1]);
  return out;
}

// 卡面一侧（<pa>/<pb>）：HP/MP、攻防、神识脚力、随身物品、Buff
function combatPanel(raw) {
  const src = String(raw || '');
  const statLines = [...tagAll(src, 'statl'), ...tagAll(src, 'statr')].map(stripInnerTags);
  const clean = (t) => stripInnerTags(t).replace(/[⚔️🛡️]/g, '').trim();
  return {
    empty: !src.trim(),
    name: stripInnerTags(tagInner(src, 'pha') || tagInner(src, 'phb')),
    realm: stripInnerTags(tagInner(src, 'rem')).replace(/^\[|\]$/g, ''),
    hp: stripInnerTags(tagInner(src, 'hp_v')),
    mp: stripInnerTags(tagInner(src, 'mp_v')),
    atk: clean(statLines[0] || ''),
    def: clean(statLines[1] || ''),
    extra: stripInnerTags(tagInner(src, 'stats')),
    items: tagAll(src, 'itm').map(stripInnerTags).filter(Boolean),
    buff: stripInnerTags(tagInner(src, 'buf')).replace(/^[✨]/, ''),
  };
}

// <log> 内的回合推演：<lm> 回合头、<lc> 算式、<ld> 结算
function parseBattleRounds(logSrc) {
  const rounds = [];
  const re = /<lm(?:\s[^>]*)?>([\s\S]*?)<\/lm>|<lc(?:\s[^>]*)?>([\s\S]*?)<\/lc>|<ld(?:\s[^>]*)?>([\s\S]*?)<\/ld>/gi;
  let m;
  while ((m = re.exec(String(logSrc || '')))) {
    if (m[1] !== undefined) {
      const head = m[1];
      const actor = stripInnerTags(
        head.replace(/<gold[\s\S]*?<\/gold>/gi, ' ')
          .replace(/<ask[\s\S]*?<\/ask>/gi, ' ')
          .replace(/<cst[\s\S]*?<\/cst>/gi, ' ')
      );
      rounds.push({
        round: stripInnerTags(tagInner(head, 'gold')).replace(/[[\]]/g, ''),
        actor,
        skill: stripInnerTags(tagInner(head, 'ask')).replace(/^[「『]|[」』]$/g, ''),
        cost: stripInnerTags(tagInner(head, 'cst')),
        calc: '', result: '',
      });
    } else {
      const cur = rounds[rounds.length - 1];
      if (!cur) continue;
      if (m[2] !== undefined) cur.calc = stripInnerTags(m[2]);
      else cur.result = stripInnerTags(m[3]);
    }
  }
  return rounds;
}

function BattleLog({ raw }) {
  const rounds = parseBattleRounds(raw);
  if (!rounds.length) {
    const plain = stripInnerTags(String(raw || '').replace(/<\/?log>/gi, ''));
    if (!plain) return null;
    return <div className="mortal-battle-log"><div className="bl-plain">{plain}</div></div>;
  }
  return (
    <div className="mortal-battle-log">
      {rounds.map((r, i) => (
        <div className="bl-round" key={i}>
          <div className="bl-head">
            {r.round && <span className="bl-badge">{r.round}</span>}
            {r.actor && <span className="bl-actor">{r.actor}</span>}
            {r.skill && <span className="bl-skill">「{r.skill}」</span>}
            {r.cost && <span className="bl-cost">{r.cost}</span>}
          </div>
          {r.calc && <div className="bl-calc">{r.calc}</div>}
          {r.result && <div className="bl-dmg">{r.result}</div>}
        </div>
      ))}
    </div>
  );
}

function CombatPanelView({ p, align }) {
  if (p.empty) return null;
  return (
    <div className={`bc-side ${align}`}>
      <div className="bc-name">
        {p.realm && <span className="bc-realm">{p.realm}</span>}
        {p.name || '？'}
      </div>
      <div className="bc-pools">
        {p.hp && <span className="bc-pool hp">HP {p.hp}</span>}
        {p.mp && <span className="bc-pool mp">MP {p.mp}</span>}
      </div>
      <div className="bc-stats">
        {p.atk && <span>{p.atk}</span>}
        {p.def && <span>{p.def}</span>}
        {p.extra && <span>{p.extra}</span>}
      </div>
      {p.items.length > 0 && (
        <div className="bc-items">{p.items.map((t, i) => <span className="bc-item" key={i}>{t}</span>)}</div>
      )}
      {p.buff && <div className="bc-buff">✦ {p.buff}</div>}
    </div>
  );
}

function BattleCard({ raw }) {
  const inner = String(raw || '').replace(/^<card[^>]*>/i, '').replace(/<\/card>\s*$/i, '');
  const head = tagInner(inner, 'head');
  const pan = tagInner(inner, 'pan');
  const logSrc = tagInner(inner, 'log');
  const res = tagInner(inner, 'res');
  const A = combatPanel(tagInner(pan, 'pa'));
  const B = combatPanel(tagInner(pan, 'pb'));
  return (
    <div className="mortal-battle-card">
      <div className="bc-head">
        <span className="bc-atk">{stripInnerTags(tagInner(head, 'atk')) || '战斗'}</span>
        <span className="bc-vs">对决</span>
        <span className="bc-def">{stripInnerTags(tagInner(head, 'def'))}</span>
      </div>
      {(!A.empty || !B.empty) && <div className="bc-pan"><CombatPanelView p={A} align="a" /><CombatPanelView p={B} align="b" /></div>}
      <BattleLog raw={logSrc || inner} />
      {(stripInnerTags(tagInner(res, 'win')) || stripInnerTags(tagInner(res, 'mvp'))) && (
        <div className="bc-res">
          {stripInnerTags(tagInner(res, 'win')) && <span className="bc-win">{stripInnerTags(tagInner(res, 'win'))}</span>}
          {stripInnerTags(tagInner(res, 'rnd')) && <span className="bc-rnd">{stripInnerTags(tagInner(res, 'rnd'))}</span>}
          {stripInnerTags(tagInner(res, 'mvp')) && <span className="bc-mvp">{stripInnerTags(tagInner(res, 'mvp'))}</span>}
        </div>
      )}
    </div>
  );
}

// 运行时标签集合（流式截断用）
const RUNTIME_TAGS = ['ui_sys', 'scene_checkpoint', 'cultivation_card', 'card', 'log'];

function OptionButton({ text, onPick }) {
  const raw = String(text || '');
  // 名字外面的 markdown 星号在这里再剥一次（选项也可能从别处直接传进来）：
  //   **【暗中布局】**：改变策略  →  【暗中布局】改变策略
  const t = raw.replace(/^\s*\*\*\s*/, '').replace(/\s*\*\*\s*$/, '').trim();
  const m = t.match(/^(【[^】]+】)\s*[：:]?\s*(.*)$/);
  const name = m ? m[1] : '';
  const body = m ? m[2] : t;
  return (
    <button className="mortal-option-btn" onClick={() => onPick && onPick(raw)} title="点击填入发送框">
      {name && <span className="opt-name">{name}</span>}
      {body}
    </button>
  );
}

// 修炼结算卡：<cultivation_card>{"type":"progress",...}</cultivation_card>
function CultivationCard({ data }) {
  let j = null;
  try { j = typeof data === 'string' ? JSON.parse(data) : data; } catch { j = null; }
  if (!j || typeof j !== 'object') return null;
  const isBreak = j.type === 'breakthrough';
  const realm = isBreak ? `${j.from || '?'} → ${j.to || '?'}` : (j.toRealm ? `${j.fromRealm || '?'} → ${j.toRealm}` : (j.realm || ''));
  const progress = j.old != null && j.new != null ? `${j.old}% → ${j.new}%${j.gain != null ? `（+${j.gain}）` : ''}` : '';
  // 卡上的数字全部由 AI 按修炼协议现算后填（2026-09-22 起，程序不再预填任何一个）：
  //   time       = 这一场实际花掉的时间（玩家说两天就是两天）；
  //   efficiency = 本轮修炼速度（「×1.4」这种倍率）；
  //   remain     = 照当前进度练满本层还需多久（跨境界/突破卡不填，进度已归零重算）。
  // 为什么不由程序算：耗时的公式里含一项「运气」，每次闭关都在浮动，预先算出来的
  // 数字只对那一刻摇到的运气成立 —— 写进卡片就是假精确（见 data/cultivationParams.js）。
  const timeText = j.time || '';
  const remainText = j.remain || '';
  const speedText = j.efficiency || '';
  return (
    <div className="mortal-cultivation-card">
      <div className="cv-title">{isBreak ? '⚡ 突破 · ' : '☯ 修炼 · '}{j.characterName || ''}</div>
      <div className="cv-row">{realm && <span>境界：<b>{realm}</b></span>}{progress && <span>进度：<b>{progress}</b></span>}{j.bottleneck != null && <span>距瓶颈：<b>{j.bottleneck}</b></span>}</div>
      <div className="cv-row">{timeText && <span>耗时：<b>{timeText}</b></span>}{remainText && <span>本层还需：<b>{remainText}</b></span>}{speedText && <span>速度：{speedText}</span>}{j.foundation != null && <span>积淀：{j.foundation}</span>}{j.result && <span>结果：{j.result}</span>}</div>
      {j.note && <div className="cv-row" style={{ marginTop: 4 }}><span style={{ color: 'var(--text-dim)' }}>批注：{j.note}</span></div>}
    </div>
  );
}

// ui_sys 状态栏：保留 emoji 与文本，去掉 HTML 标签
function UiSysBar({ raw }) {
  const text = String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  return <div className="mortal-ui-sys">{text.split('\n').filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</div>;
}

// scene_checkpoint：保留标签文字与 data-* 属性
function Checkpoint({ raw }) {
  const s = String(raw || '');
  const loc = s.match(/data-location="([^"]*)"/)?.[1] || '';
  const time = s.match(/data-time="([^"]*)"/)?.[1] || '';
  const label = s.replace(/<[^>]*>/g, '').trim() || '时空流转';
  return <div className="mortal-checkpoint" title={`${time} ${loc}`}>⏳ {label}{time ? ` · ${time}` : ''}</div>;
}

// 把一段纯语义文本解析为块级元素（对话/转场/块标记/选项/普通段落）
function emitBlocks(src, out, onPickOption, keyBase) {
  const lines = String(src || '').split('\n');
  let i = 0;
  const pushProse = (t) => {
    const s = t.trim();
    if (s) out.push(<p className="mortal-prose" key={keyBase + 'p' + out.length}>{renderInline(s)}</p>);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    // ::dialogue 块：头行 + 后续正文行
    if (/^::dialogue\b/i.test(trimmed)) {
      const { speaker, tone, id } = parseDialogueHeader(trimmed);
      const dlgLines = [];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(::|<\/?\w)/.test(lines[i].trim())) {
        dlgLines.push(lines[i].trim());
        i++;
      }
      const toneCls = TONE_CLASS[tone?.toLowerCase()] || (id === 'B1' ? 'tone-player' : '');
      out.push(
        <div className={`mortal-dialogue ${toneCls}`} key={keyBase + 'd' + out.length}>
          <div className="dlg-head"><span className="dlg-speaker">{speaker}</span>{tone && <span className="dlg-tone">{tone}</span>}</div>
          <div className="dlg-text">{renderInline(dlgLines.join('\n'), 'dlg')}</div>
        </div>
      );
      continue;
    }

    // ::break 转场
    if (/^::break\b/i.test(trimmed)) {
      const label = trimmed.replace(/^::break\s*\w*\s*/i, '').trim();
      out.push(<div className="mortal-break" key={keyBase + 'b' + out.length}>{label || '✦'}</div>);
      i++;
      continue;
    }

    // 其它 :: 块标记（scene/jade/bamboo/aside/scroll/seal/thought/focus）
    const bm = trimmed.match(/^::(scene|jade|bamboo|aside|thought|focus)(?:\s+\w*)?\s*(.*)$/i);
    if (bm) {
      const kind = bm[1].toLowerCase();
      const blockLines = [];
      if (bm[2]) blockLines.push(bm[2]);
      i++;
      while (i < lines.length && lines[i].trim() && !/^(::|<\/?\w)/.test(lines[i].trim())) {
        blockLines.push(lines[i].trim());
        i++;
      }
      out.push(<div className={`mortal-block ${BLOCK_CLASS[kind] || ''}`} key={keyBase + 'k' + out.length}>{renderInline(blockLines.join('\n'), kind)}</div>);
      continue;
    }

    // 选项区：从当前行开始连续 ≥2 行选项（编号或破折号/圆点）
    if (matchOptLine(trimmed)) {
      const opts = [];
      let j = i;
      while (j < lines.length) {
        const om = matchOptLine(lines[j]);
        if (om === null) break;
        opts.push(om);
        j++;
      }
      if (opts.length >= 2) {
        out.push(
          <div className="mortal-options" key={keyBase + 'o' + out.length}>
            {opts.map((t, k) => <OptionButton key={k} text={t} onPick={onPickOption} />)}
          </div>
        );
        i = j;
        continue;
      }
    }

    // 普通段落：累积到空行 / 标记行 / 选项行
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^(::|<\/?\w)/.test(lines[i].trim())
      && !matchOptLine(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) pushProse(para.join('\n'));
    else { pushProse(trimmed); i++; } // 兜底：孤立残片
  }
}

/**
 * 正文渲染主组件
 * @param {string} text AI 输出的原始正文（含语义标记与运行时标签）
 * @param {(optText: string) => void} onPickOption 选项点击回调（填入发送框）
 * @param {object} [palette] settings.textRules.colorPalette：正文着色词表
 *   mode='strict' 且词表非空时，词表外的 <font color> 一律不着色（回退默认字色）
 */
export default function StoryRenderer({ text, onPickOption, palette }) {
  const resolver = useMemo(() => makeColorResolver(palette), [palette]);
  const resolveColor = resolver.resolve;
  let src = String(text || '');
  if (!src.trim()) return null;

  // 预清理 0：丢掉「不给玩家看」的内部块 —— HTML 注释 <!-- … --> 与 <think>…</think>。
  // 协议固定模板把「战斗推演」整段写成 <!-- 战斗推演: … -->，本意是不显示；但渲染器不认注释，
  // 于是整段推演原文进了正文（实测）。更隐蔽的坑：注释里若写了 <card>/<log>，会被下面的抽取
  // 当成**真卡片**渲染出来。另注意下面那行剥壳清单只删标签不删内容 —— 对 <content> 是对的
  // （内容就是正文），对 <think> 是错的（思考会当正文漏出去），所以这里必须连内容一起丢。
  const dropInner = (re, openTag) => {
    src = src.replace(re, '');
    const at = src.lastIndexOf(openTag);
    if (at < 0) return;
    const tail = src.slice(at);
    // 未闭合（流式截断 / AI 漏写收尾）：只在这截确实像推演块时才整块丢，免得把后面的正文一起吞掉；
    // 若后面紧跟着运行时标签（AI 漏写收尾直接接卡片），就从标签处接回来。
    if (/战斗推演|数据罗列|Step\s*\d|Math\s*:|Status_Update/.test(tail)) {
      const keep = tail.search(/<(?:card|log|ui_sys|scene_checkpoint|cultivation_card)\b/i);
      src = src.slice(0, at) + (keep >= 0 ? tail.slice(keep) : '');
    } else {
      src = src.split(openTag).join(''); // 只是开标记写坏 → 去掉它，内容仍当正文
    }
  };
  dropInner(/<!--[\s\S]*?-->/g, '<!--');
  dropInner(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '<think');
  src = src.replace(/<\/?think(?:ing)?>/gi, ''); // 清理残留的单侧 think 标记

  // 预清理 0.5：首遇建档块（阶段 1 的 <new_char>{完整快照}</new_char>）不给玩家看。
  // 正常路径已在流式接收时剥离（见 GameDashboard），这里兜住旧存档与漏剥的情况。
  src = stripNewCharBlocks(src);

  // 预清理 0.7：战斗接管指令（<battle>{json}</battle>）不给玩家看 —— 它是开战参数，由 GameDashboard 解析。
  // 必须连内容一起丢：只删标签会把一大段 JSON 当正文漏出去（旧渲染器就只删标签）。
  // 流式未闭合时从最后一个 <battle 起整段丢弃：战斗布置永远不是正文的一部分。
  src = src.replace(/<battle\b[^>]*>[\s\S]*?<\/battle>/gi, '');
  {
    const at = src.lastIndexOf('<battle');
    if (at >= 0 && !/<\/battle>/i.test(src.slice(at))) src = src.slice(0, at);
  }

  // 预清理 1：AI 偶发把运行时标签写坏。三种变体都会让后面的标签识别全部失配，于是原文泄漏进正文：  //   (a) `<` 后断行：`<↵scene_checkpoint …>`
  //   (b) 标签名内部断行/插空格：`<scene↵_checkpoint …>`、`<scene _checkpoint …>`
  //   (c) 开尖括号被写成语义标记前缀（实测）：`::scene_checkpoint …>`、`::log`
  //       —— 最隐蔽：`::scene` 会被 DSL 标记吃掉，剩下的 `_checkpoint …>` 当正文泄漏，
  //          而结尾的 `</scene_checkpoint>` 又会被下面的「清理残留闭标签」静默删掉。
  src = src.replace(/<\s*(scene_checkpoint|ui_sys|cultivation_card|card|log|battle)\b/gi, '<$1');
  src = src.replace(/(^|\s)::(\/?)(scene_checkpoint|ui_sys|cultivation_card|card|log|battle)\b/gi,
    (m, pre, slash, name) => `${pre}<${slash}${name}`);
  // 上一种误写通常连收尾的 '>' 也没写（实测 `::log⏎<lm>…`）——行内找不到 '>' 就补一个，
  // 否则整块既匹配不到标签、又会把开头的 `<log` 与后面的 `</log>` 一起当正文漏出去。
  src = src.replace(/<(scene_checkpoint|ui_sys|cultivation_card|card|log|battle)\b([^\n>]*)(\n|$)/gi,
    (m, name, rest, tail) => `<${name}${rest}>${tail}`);
  src = src.replace(/<(scene|ui|cultivation)[\s_]{1,4}(checkpoint|sys|card)\b/gi,
    (m, a, b) => `<${a}_${b}`);
  // 预清理 2：角色引用 wiki 链接 [[C1|南宫婉儿]] / [[南宫婉儿]] → 仅保留名字
  src = src.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
  // 预清理 3：<font color=…> → 行内着色哨兵（放这里才能参与后面的块解析，不泄露裸标签）
  src = fontToMark(src, resolveColor);

  // 1) 抽出运行时标签（ui_sys/checkpoint/修炼卡/战斗卡），替换为占位符
  const segments = [];
  let rest = src.replace(/<\/?(?:content|think|thinking|state|upstore|branches|dual_cultivation|battle)[^>]*>/gi, '');

  // 流式安全：截掉尚未闭合的运行时标签（半截标签不显示，闭合后整块渲染）
  // 注意必须在 extract 之前做，否则半截 <ui_sys> 会以原文形式漏进正文
  for (const tag of RUNTIME_TAGS) {
    const open = rest.lastIndexOf(`<${tag}`);
    if (open < 0) continue;
    if (rest.indexOf(`</${tag}>`, open) >= 0) continue; // 已闭合
    const gt = rest.indexOf('>', open);
    // 自闭合形式（<scene_checkpoint .../>）无需闭合标签；仅当 '>' 已到且紧邻 '/' 时视为完整
    if (gt >= 0 && rest[gt - 1] === '/') continue;
    // 开标签已完整（'>' 已到）且该标签有兜底胶囊（scene_checkpoint）——不截断：
    // 最终文本可能是 AI 漏写闭合，截断会把后续正文整段吞掉；流式下由兜底胶囊先接管，闭合后整块重渲染
    if (gt >= 0 && tag === 'scene_checkpoint') continue;
    rest = rest.slice(0, open).replace(/\s+$/, '');
  }

  const extract = (re, make) => {
    rest = rest.replace(re, (m, g1) => {
      // 注意：正则必须带捕获组；无捕获组时 g1 拿到的是偏移量（数字）
      segments.push(make(g1 !== undefined ? g1 : m));
      return `\u0001SEG${segments.length - 1}\u0001`;
    });
  };
  extract(/<ui_sys>([\s\S]*?)<\/ui_sys>/gi, (raw) => <UiSysBar raw={raw} />);
  extract(/(<scene_checkpoint[^>]*>[\s\S]*?<\/scene_checkpoint>|<scene_checkpoint[^>]*\/>)/gi, (raw) => <Checkpoint raw={raw} />);
  extract(/<cultivation_card>([\s\S]*?)<\/cultivation_card>/gi, (raw) => <CultivationCard data={raw} />);
  extract(/(<card[\s\S]*?<\/card>)/gi, (raw) => <BattleCard raw={raw} />);
  // 裸战斗日志（AI 漏写 <card> 外壳时的兜底）：<log>…</log>
  extract(/(<log>[\s\S]*?<\/log>)/gi, (raw) => <BattleLog raw={raw} />);

  // 兜底：AI 漏写闭合标签的锚点（如自闭合写成普通开标签）——按属性渲染胶囊，避免原文泄漏
  rest = rest.replace(/<scene_checkpoint([^>]*)>/gi, (m, attrs) => {
    segments.push(<Checkpoint raw={`<scene_checkpoint${attrs}></scene_checkpoint>`} />);
    return `\u0001SEG${segments.length - 1}\u0001`;
  });
  rest = rest.replace(/<\/?scene_checkpoint>/gi, '');

  // 2) 按占位符切分，普通片段走块解析，占位符原位插入
  const out = [];
  const parts = rest.split(/(\u0001SEG\d+\u0001)/);
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    const sm = part.match(/^\u0001SEG(\d+)\u0001$/);
    if (sm) {
      out.push(<React.Fragment key={'seg' + sm[1]}>{segments[Number(sm[1])]}</React.Fragment>);
    } else {
      emitBlocks(part, out, onPickOption, 'x' + k + '_');
    }
  }

  return <div className="story-rendered">{out}</div>;
}
