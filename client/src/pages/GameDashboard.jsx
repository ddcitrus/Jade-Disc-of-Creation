import React, { useState, useEffect, useRef, useCallback } from 'react';
import { computeAttrs, rootDisplayName, ROOT_CULTIVATE_RATE } from '../data/gameData.js';
import {
  migrateSave, buildSnapshotPayload, snapshotSummaryText, applyAIState,
  buildCharSnapshotBundle, applyEvolvedSnapshots, applyEvolutionV2, persistCharSnapshots, applySnapshotPayload,
  ingestNewCharBlocks, carryPlayerOwnedFields,
} from '../saveModel.js';
import { extractStoryTime, parseWorldTime, applyWorldTime } from '../engine/worldTime.js';
import { openingNarrative, turnNarrative, quickActionNarrative, buildAIPrompt } from '../engine/narrative.js';
import { parseStateBlock, assembleStoryPrompt } from '../engine/promptSystem.js';
import { assembleEvolutionPrompt, assembleEvolutionPromptV2, isV2Preset } from '../engine/evolutionPrompt.js';
import { validateEvolutionResult, snapshotFromCharacter, attrRows, attrBonusHint, characterAttrMods } from '../data/snapshotSchema.js';
import { stripNewCharBlocks } from '../data/snapshotV2.js';
import { parseBattleBlock, stripBattleBlocks, buildBattleFromSpec, describeBattleSetup, battleNarrativeMessages, applyBattleOutcome } from '../data/battleTrigger.js';
import { createBattle } from '../data/battleEngine.js';
import BattleView from './BattleView.jsx';
import { api } from '../api.js';
import StoryRenderer from '../components/StoryRenderer.jsx';
import { EvolutionPage, SavesManagerPage, FactorsPage, WorldBookPage } from './GamePages.jsx';
import { SnapshotsPage, AssistantPage, MapPage } from './ExtraPages.jsx';
import NumericPage from './NumericPage.jsx';
import ConstraintsPage from './ConstraintsPage.jsx';
import CharacterPanel from './CharacterPanel.jsx';
import SettingsPage from './SettingsPage.jsx';
import { storyEndpointOf, snapshotEndpointOf } from '../data/apiEndpoints.js';
import { PLOT_STYLES } from '../saveModel.js';
import { useToast, Spinner } from '../ui.jsx';
import { readTheme, applyTheme, THEMES } from '../theme.js';
import { storyWordQuotaText, VIEWPOINT_CONTRACT } from '../prompts/contracts.js';
import { memoryCompressorText, phaseSummarizerText } from '../prompts/assistant.js';

const PLOT_STYLE_NAMES = (save) => PLOT_STYLES.filter(s => save.plot?.styles?.[s.id]?.selected).map(s => s.name);

const QUICK = ['静观其变', '顺势而为', '时光流转'];

// 检测演化预设是否为 concurrent 结构（决定服务端用宽松校验）
function isConcurrentPreset(rules) {
  return !!(rules && typeof rules === 'object'
    && (rules.sharedRules || rules.itemSharedRules || (rules.prompts && typeof rules.prompts === 'object' && !Array.isArray(rules.prompts))));
}

// 左侧导航：图标用「单字」而不是 emoji —— 鬼谷八荒那一套是墨线小印，
// 彩色 emoji 混在鎏金深底上是最出戏的一块。单字用楷体，配合下方 .nav-icon 的小金框。
const NAV_ITEMS = [
  { id: 'story', name: '故事', icon: '事' },
  { id: 'evolution', name: '剧情演化', icon: '演' },
  { id: 'saves', name: '存档修改', icon: '档' },
  { id: 'factors', name: '世界因子', icon: '因' },
  { id: 'worldbook', name: '世界书', icon: '典' },
  { id: 'characters', name: '查看人物', icon: '人' },
  { id: 'assistant', name: '天道助手', icon: '道' },
  { id: 'snapshots', name: '快照', icon: '快' },
  { id: 'map', name: '地图', icon: '图' },
  { id: 'numeric', name: '数值表', icon: '数' },
  { id: 'constraints', name: '其它约束', icon: '约' },
  { id: 'settings', name: '设置', icon: '设' },
];

export default function GameDashboard({ save: rawSave, updateSave, saveNow, onExit, onSwitchSave, onNewSave }) {
  const save = migrateSave(rawSave); // 补齐缺失字段 + 自愈脏数据
  const [page, setPage] = useState('story'); // story|evolution|saves|factors|worldbook|assistant|snapshots|map|numeric|settings
  const [showChars, setShowChars] = useState(false); // 角色滑出面板
  const [theme, setTheme] = useState(readTheme); // 'dark' 玄墨 / 'light' 宣纸
  const [settings, setSettings] = useState(null);
  const [savesRefresh, setSavesRefresh] = useState(0);
  const [story, setStory] = useState(() => save.story?.length ? save.story : [{ turn: 0, role: 'tiandao', text: openingNarrative(save), timeLabel: save.world.timeLabel }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(''); // '' | 'story' | 'evolve'
  const [saved, setSaved] = useState(true);
  const [autoTurn, setAutoTurn] = useState(false);
  const [fontSize, setFontSize] = useState(15.5);
  const [lineHeight, setLineHeight] = useState(1.95); // 正文行距（设置页「显示与字体」可调）
  // 字数规范（「自动下回合」右侧可编辑，自动注入提示词）
  const [wordRange, setWordRange] = useState({ min: 200, max: 400 });
  const wordSaveTimer = useRef(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null); // 当前回合的中止控制器（停止按钮用）
  const pendingRegen = useRef(null); // 待重生成回合的用户输入（右键「重新生成」）
  // 最新内存存档的镜像：一个回合要跑几十秒，期间玩家可能去管理页改「剧情方向与风格」。
  // 那些字段由玩家自持（见 saveModel.PLAYER_OWNED_PATHS），落盘时必须取这一刻的最新副本，
  // 否则回合结束时整份写回，玩家在这段时间里的改动会被冲掉。
  // （世界书以前也在这张清单里，改成跨存档公用文件后已不在存档里，自然免疫。）
  const latestSaveRef = useRef(save);
  const [ctxMenu, setCtxMenu] = useState(null); // 回合右键菜单 { x, y, index }
  const [editing, setEditing] = useState(null); // 正在编辑的玩家发言 { index, text }
  const [queuedResend, setQueuedResend] = useState(null); // 生成中排队的「编辑后重新发送」{ index, text }
  // 战斗接管：{ setup, note, errors, warnings, collapsed } —— 非空即表示有一场待打/正在打的战斗
  const [battle, setBattle] = useState(null);
  const toast = useToast();

  // ESC 关闭抽屉
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') setShowChars(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mode = settings?.mode || 'local';
  // 世界时间由 AI 自主规划（已取消「每回合推进 N 小时」的固定机制）——见 engine/worldTime.js

  const settingsRef = useRef(null); // 当前已加载的设置（用于新旧比对）
  useEffect(() => {
    api.getSettings().then(s => {
      // 设置页是自动保存的，返回时可能有一次竞态读取到旧值；这里以 _savedAt 版本戳为准保留较新的一份
      const prev = settingsRef.current;
      const keep = (prev && (prev._savedAt || 0) > (s._savedAt || 0)) ? prev : s;
      settingsRef.current = keep;
      setSettings(keep);
      if (keep.fontSize) setFontSize(keep.fontSize);
      if (keep.lineHeight) setLineHeight(keep.lineHeight);
      if (keep.textRules?.minWords || keep.textRules?.maxWords) {
        setWordRange({ min: keep.textRules.minWords || 200, max: keep.textRules.maxWords || 400 });
      }
    }).catch(() => {});
  }, [save.id, page]); // 依赖 page：从设置页切回时重新拉取（行距/字号等即时生效）
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  // 每次渲染后刷新「最新存档」镜像（剧情方向与风格等玩家自持字段以它为准）
  useEffect(() => { latestSaveRef.current = save; }, [save]);

  // 字数规范变更：防抖 800ms 自动保存到服务端 settings.textRules
  useEffect(() => {
    if (wordSaveTimer.current) clearTimeout(wordSaveTimer.current);
    if (!settings) return; // settings 未加载完成前不保存
    if ((settings.textRules?.minWords || 200) === wordRange.min && (settings.textRules?.maxWords || 400) === wordRange.max) return; // 无变化
    wordSaveTimer.current = setTimeout(async () => {
      try {
        const next = { ...settings, textRules: { ...(settings.textRules || {}), minWords: wordRange.min, maxWords: wordRange.max } };
        await api.putSettings(next);
        setSettings(next);
        toast('ok', `字数规范已保存：${wordRange.min}-${wordRange.max} 字`);
      } catch { toast('err', '字数规范保存失败'); }
    }, 800);
    return () => { if (wordSaveTimer.current) clearTimeout(wordSaveTimer.current); };
  }, [wordRange]);

  // 底部跟随：仅当用户本来就停在底部附近时才随新内容滚动；
  // 向上翻阅（离开底部 60px 以上）后，流式输出不再强制把页面拉回底部
  const stickBottomRef = useRef(true);
  useEffect(() => {
    stickBottomRef.current = true; // 切换页面/进入故事页时默认跳到最新
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [page]);
  const handleStoryScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);
  useEffect(() => {
    if (!stickBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [story]);

  // 切换存档：父级通常用 key={save.id} 把本组件整体重挂载（story 等状态随之重建）。
  // 这里再兜一道——万一实例被复用（save.id 变了但没重挂载），按新存档重新装载故事与编辑态，
  // 否则会出现「切了存档，正文还是上一个存档的」。
  useEffect(() => {
    setStory(save.story?.length ? save.story : [{ turn: 0, role: 'tiandao', text: openingNarrative(save), timeLabel: save.world.timeLabel }]);
    setEditing(null);
    setQueuedResend(null);
    setCtxMenu(null);
    setInput('');
    setPage('story');
    pendingRegen.current = null;
    stickBottomRef.current = true;
  }, [save.id]);

  // 世界书跨存档共用：保存只写 server/data/worldbook.json 那一份，并同步刷新内存里的设置
  // （提示词组装、世界书页、快照详情页读的都是 settings.worldbook）
  const saveWorldbook = useCallback(async (list) => {
    const saved = await api.putWorldbook(list);
    setSettings(prev => ({ ...(prev || {}), worldbook: saved }));
    return saved;
  }, []);

  const persist = useCallback(async (newStory, newSave) => {
    // 玩家自持字段（剧情方向与风格）取「这一刻的最新副本」，不跟着本回合开跑时的旧副本回滚：
    // 回合从开跑到落盘隔了几十秒，玩家常在这段时间里改方向，整份写回会把那次改动冲掉。
    const s = carryPlayerOwnedFields(
      { ...newSave, story: newStory, turnCount: newStory.filter(x => x.role !== 'tiandao').length },
      latestSaveRef.current,
    );
    // 修炼耗时不由程序预先计算（2026-09-22 删）：公式里含「运气」浮动，预先算出的
    // 「本层还需 X 年」只对那一刻成立。程序只把原始数据交出去（见 data/cultivationParams.js
    // 与 mortalProtocols 的「耗时怎么算」段），数字由 AI 本轮现算并写进卡片。
    updateSave(s);
    setSaved(false);
    try { await saveNow(s); setSaved(true); } catch { setSaved(false); }
    return s;
  }, [updateSave, saveNow, settings]);

  const doTurn = useCallback(async (actionText) => {
    if (busy) return;
    // 战斗未结算前不接受新回合：战斗里的气血损耗必须先回到存档，否则会被下一回合的
    // 演化快照整体覆盖掉（AI 演化看到的还是满血，等于白打）。
    if (battle) { toast('warn', '战斗进行中，请先在战斗界面打完并结算'); return; }
    setBusy(true);
    setStage('story');
    try {
      const current = { ...save, story };
      let newStory = [...story];
      // ===== 用户输入立即显示 =====
      if (actionText?.trim()) {
        // prePayload = 本回合开始前的完整状态（右键「重新生成」的快照回滚依据）
        newStory.push({ turn: newStory.length, role: 'user', text: actionText.trim(), timeLabel: current.world.timeLabel, prePayload: buildSnapshotPayload(current) });
        setStory(newStory); // 立即渲染用户输入，不等 AI
      }

      // 时间不再由程序推进：本回合的最终世界时间从 AI 输出中读取（见本函数末尾 extractStoryTime）

      let text;
      let nextSave = current;
      let aborted = false; // 用户点了「停止」
      let storyFailed = false; // 正文生成失败（跳过演化，等待用户重新生成）
      let evolveWorldTime = ''; // 演化阶段 AI 报出的世界时间（正文解析不到时的兜底）
      let battleIntent = null;  // 正文里的 <battle> 指令（战斗接管模式用；演化完再开战）
      // 正文的**原始全文**（含 <new_char> / <battle> 块，未剥离）——流式接收时逐字累积。
      // 必须在 if 块**外面**声明：战斗建局那一段在 if 之外（演化完才开战），却要用它给
      // 「点名参战但没档案」的人从 ::dialogue 标记里认名字。声明在块内 ⇒ 块外引用直接抛
      // ReferenceError: fullText is not defined，而战斗指令恰好只在开战时出现 ——
      // 症状是「平时一切正常，一开打就报回合生成失败」（2026-09-20 真机踩到）。
      let rawFullText = '';
      if (mode === 'ai') {
        // 中止控制器：停止按钮触发 abort
        const ac = new AbortController();
        abortRef.current = ac;
        // ===== Stage 1：正文生成（流式） =====
        const history = story.slice(-4).map(b => `${b.role === 'user' ? '【玩家】' : '【旁白】'}${b.text}`).join('\n\n');
        // 字数规范实时注入（「自动下回合」右侧控件可改，无需进设置页）
        const effSettings = { ...settings, textRules: { ...(settings?.textRules || {}), minWords: wordRange.min, maxWords: wordRange.max } };
        const storyMessages = assembleStoryPrompt(effSettings, current, actionText, history);
        // 篇幅硬约束：置于消息末尾（LLM 对末尾指令服从度最高）。
        // 预设「篇幅」段的"以 X 字为目标"是弱约束，模型常偷懒写短，这里再压一道硬指标。
        // 经验：给"区间"模型会贴下限写，故锚定区间上半段并给出明确目标字数
        const targetWords = Math.max(wordRange.min, Math.round(wordRange.max * 0.9));
        const floorWords = Math.max(wordRange.min, Math.round((wordRange.min + wordRange.max) / 2));
        storyMessages.push({
          role: 'system',
          content: storyWordQuotaText({ targetWords, floorWords, wordRange }),
        });
        // 视点硬约束：整条请求的最后一条消息（服从度最高）。
        // 预设的「写作风格」段常要求"大量内心独白、直接给出"，那是第三人称小说的写法；
        // 在第二人称下会变成替玩家表态（"你发现自己并不害怕杀人"）。这里再钉一遍，防预设压过。
        storyMessages.push({
          role: 'system',
          content: VIEWPOINT_CONTRACT,
        });

        // 流式接收，边收边显示，过滤思维链
        let fullText = '';
        let displayBuf = '';   // 过滤 <thinking>/<state> 之后的原始串（可能还含首遇建档块）
        let displayText = '';  // 真正上屏的正文（建档块已摘掉）
        let inThinking = false;
        let thinkingBuf = '';
        // 先 push 一个空的 ai 块占位，后续追加
        const aiTurn = newStory.length;
        newStory = [...newStory, { turn: aiTurn, role: 'ai', text: '', timeLabel: current.world.timeLabel, streaming: true }];
        setStory(newStory);

        try {
          for await (const chunk of api.aiStoryStream(storyMessages, ac.signal)) {
            if (chunk.type === 'delta') {
              const delta = chunk.text || '';
              fullText += delta;
              // 过滤 <thinking>...</thinking>（不显示给用户）
              // 处理跨 chunk 的标签
              let remaining = delta;
              while (remaining) {
                if (inThinking) {
                  // 在思维链内，找结束标签
                  const idx = remaining.indexOf('</thinking>');
                  if (idx >= 0) {
                    thinkingBuf += remaining.slice(0, idx);
                    inThinking = false;
                    remaining = remaining.slice(idx + '</thinking>'.length);
                  } else {
                    thinkingBuf += remaining;
                    remaining = '';
                  }
                } else {
                  // 在正文内，找开始标签
                  const idx = remaining.indexOf('<thinking>');
                  if (idx >= 0) {
                    displayBuf += remaining.slice(0, idx);
                    inThinking = true;
                    thinkingBuf = '';
                    remaining = remaining.slice(idx + '<thinking>'.length);
                  } else {
                    // 也过滤 <state>、<upstore> 标签内容（演化阶段才用，正文不显示）
                    const stateIdx = remaining.indexOf('<state>');
                    if (stateIdx >= 0) {
                      displayBuf += remaining.slice(0, stateIdx);
                      remaining = ''; // 剩余交给演化阶段处理
                    } else {
                      displayBuf += remaining;
                      remaining = '';
                    }
                  }
                }
              }
              // 首遇建档块（<new_char>…</new_char>）与战斗接管指令（<battle>…</battle>）都不给玩家看
              displayText = stripBattleBlocks(stripNewCharBlocks(displayBuf));
              // 实时更新 story
              newStory = [...newStory];
              newStory[aiTurn] = { ...newStory[aiTurn], text: displayText, streaming: true };
              setStory(newStory);
            } else if (chunk.type === 'reset') {
              // 服务端提升输出预算重新生成：丢弃半截正文，从零接收新输出
              fullText = ''; displayBuf = ''; displayText = ''; inThinking = false; thinkingBuf = '';
              newStory = [...newStory];
              newStory[aiTurn] = { ...newStory[aiTurn], text: '', streaming: true };
              setStory(newStory);
            } else if (chunk.type === 'info') {
              toast('warn', chunk.text || '');
            } else if (chunk.type === 'error') {
              throw new Error(chunk.error);
            }
          }
          text = displayText.trim() || stripBattleBlocks(stripNewCharBlocks(fullText)).trim() || 'AI 未返回内容';
          // 去掉尾部可能的 <state>/<upstore> 残留
          text = text.replace(/<state>[\s\S]*$/i, '').replace(/<upstore>[\s\S]*$/i, '').trim() || text;
          // 战斗接管：正文里若带了 <battle> 指令，先摘出来，等阶段 2 把快照演化完再开战
          // （用 fullText 而不是 text —— 正文流在遇到 <state> 时会提前截断，指令可能落在截断之后）
          battleIntent = parseBattleBlock(fullText || text);
          text = stripBattleBlocks(text);
        } catch (e) {
          if (ac.signal.aborted || e.name === 'AbortError') {
            aborted = true;
            text = displayText.trim() || stripNewCharBlocks(fullText).trim() || '已停止，本轮未生成正文';
          } else {
            storyFailed = true;
            // 已经流下来的半段正文**不能丢**：中断时玩家最需要看到的就是它。
            // （此前这里直接把全文替换成一行错误文案，已生成的几百上千字全没了）
            const partial = stripBattleBlocks(displayText.trim() || stripNewCharBlocks(fullText).trim());
            text = partial
              ? `${partial}\n\n（生成中断：${e.message}）`
              : 'AI 生成失败：' + e.message;
          }
        }
        // 正文完成，移除 streaming 标记
        // 原始全文交给块外的战斗建局用（成功 / 中断 / 失败三条路都经过这里，故在此统一带走）
        rawFullText = fullText;
        newStory = [...newStory];
        newStory[aiTurn] = { ...newStory[aiTurn], text, streaming: false };
        setStory(newStory);

        // ===== Stage 2：快照演化（正文失败/用户停止则跳过——演化没有可用正文，跑了也是浪费） =====
        if (aborted) {
          toast('warn', '已停止：正文保留已生成部分，跳过快照演化');
        } else if (storyFailed) {
          toast('warn', '正文生成失败，已跳过快照演化——右键本回合选「重新生成」即可重试');
        } else {
        // ===== 首遇即建档：正文阶段写的 <new_char> 块立刻落档 =====
        // 这一步必须在阶段 2 之前、且在构建 currentBundle 之前：
        // 建档后新角色就此「存在」——本回合战斗卡的数字与他的档案同源，
        // 阶段 2 也不再把他当新角色（只写差异语句），不会重复建档。
        let baseSave = current;
        try {
          const intake = ingestNewCharBlocks(current, fullText, { tuning: settings?.numericTuning });
          if (intake.ids.length) {
            baseSave = intake.save;
            nextSave = intake.save;
            const persistBundle = {};
            for (const id of intake.ids) persistBundle[id] = intake.save.charSnapshots?.[id];
            persistCharSnapshots(current.id, persistBundle);
            toast('ok', `首遇建档：${intake.ids.join('、')} 已入档（战斗卡数字即档案口径）`);
            // 兜底放行的（补过默认值才合格）——说清楚补了什么，让玩家知道该去核对哪几项
            if (intake.repaired?.length) toast('warn', `建档已兜底补齐：${intake.repaired[0]}`);
          } else if (intake.rejected.length) {
            toast('warn', `首遇建档块未采用（战斗时程序仍会兜底建档）：${intake.rejected[0]}`);
          }
        } catch (e) {
          try { console.debug('[首遇建档] 异常', e); } catch { /* 忽略 */ }
          // 这一步本身炸了也不能静默吞掉：玩家需要知道「这个角色这一轮没入档」。
          // 好在战斗时程序仍会兜底建档（battleTrigger.recoverSnapshot），不会因此打不了仗。
          toast('warn', `首遇建档过程出错（本轮未入档，战斗时程序仍会兜底建档）：${e?.message || e}`);
        }
        setStage('evolve');
        try {
          const currentBundle = buildCharSnapshotBundle(baseSave, baseSave.charSnapshots || {});
          // 优先取「启用中」的演化规则预设（与设置页开关一致）；无启用项才回退到第一个
          const evolutionRules = (settings?.evolutionPresets || []).find(p => p?.enabled)
            || settings?.evolutionPresets?.[0]
            || settings?.evolutionRules
            || null;
          // 演化阶段只注入 时间/地点/因子（约 37 字符），不再注入世界书命中条目：
          // 那批条目约 9 万字符，全部落在前缀缓存的分歧点之后（每回合冷重算），
          // 对快照结算贡献极小，属纯开销。正文阶段照常注入世界书。
          const worldInfo = `时间 ${current.world?.timeLabel} · 地点 ${current.world?.location?.name} · 因子 ${(current.world?.factors || []).map(f => f.name).join('、')}`;
          // v2 预设：只让 AI 写「修改语句」+ 新角色的完整快照（服务端逐行校验，不合格打回重写）
          const v2Mode = isV2Preset(evolutionRules);
          const knownIds = Object.keys(currentBundle);
          // 各角色储物袋现状（物品名）—— 服务端用它校验「装备的物品必须先登记进储物袋」，
          // 否则装备槽只能凑出 { name }，品阶/类型/描述全空（面板上就是「物品不完整」）。
          const ownedItems = {};
          for (const [id, sn] of Object.entries(currentBundle || {})) {
            ownedItems[id] = (Array.isArray(sn?.inventory) ? sn.inventory : [])
              .map(it => (typeof it === 'string' ? it : (it?.name || it?.id || '')))
              .filter(Boolean);
          }
          const evolveMessages = v2Mode
            ? assembleEvolutionPromptV2({ storyText: text, userInput: actionText || '', snapshots: currentBundle, evolutionRules, worldInfo, knownIds, tuning: settings?.numericTuning })
            : assembleEvolutionPrompt({ storyText: text, userInput: actionText || '', snapshots: currentBundle, evolutionRules, worldInfo, tuning: settings?.numericTuning });
          const r2 = await api.aiEvolve(
            evolveMessages,
            isConcurrentPreset(evolutionRules) ? 'concurrent' : undefined,
            ac.signal,
            v2Mode ? { mode: 'v2', knownIds, ownedItems } : undefined,
          );
          if (r2?.ok && r2.result?.format === 'v2') {
            const res = r2.result;
            evolveWorldTime = res.worldTime || '';
            nextSave = applyEvolutionV2(baseSave, { init: res.init || {}, edits: res.edits || [] }, {
              tuning: settings?.numericTuning,
              onClamp: ch => toast('warn', `数值校界：${ch.length} 处越界属性已按数值表强制修正`),
              onEdits: ({ report, addedIds }) => {
                const ids = Object.keys(report || {});
                const applied = ids.reduce((n, id) => n + (report[id]?.applied?.length || 0), 0);
                const missed = ids.flatMap(id => (report[id]?.skipped || []));
                if (applied || addedIds?.length) {
                  toast('ok', `快照已更新：${applied} 处修改${addedIds?.length ? ` · ${addedIds.length} 名新角色` : ''} · 涉及 ${ids.length} 名角色`);
                }
                if (missed.length) {
                  const head = missed.slice(0, 2).join('；');
                  toast('warn', `${missed.length} 条更新没能生效：${head}${missed.length > 2 ? ` 等共 ${missed.length} 条` : ''}`);
                }
                try { console.debug('[快照修改语句]', report); } catch { /* 忽略 */ }
              },
            });
            const persistBundle = {};
            const touched = new Set([...Object.keys(res.init || {}), ...((res.edits || []).map(e => e.id))]);
            for (const id of touched) persistBundle[id] = nextSave.charSnapshots?.[id];
            persistCharSnapshots(current.id, persistBundle);
          } else if (r2?.ok && r2.result?.snapshots) {
            const v = validateEvolutionResult(r2.result);
            // 演化阶段同时报出「本轮结束时的世界时间」——正文里解析不到时用它兜底
            evolveWorldTime = v.parsed?.worldTime || r2.result.worldTime || '';
            if (v.ok || Object.keys(v.parsed?.snapshots || {}).length) {
              const rawSnaps = v.parsed?.snapshots || r2.result.snapshots;
              const deeds = r2.result.deeds || [];
              // applyEvolvedSnapshots 内部做深度合并：AI 精简输出只覆盖给出的字段，
              // 既有 bio/equipment/inventory/skills 等丰富字段自动保留；
              // 合并后按数值规则表强制校界（越界属性写回边界，「数值表」页可关闭）
              nextSave = applyEvolvedSnapshots(baseSave, rawSnaps, deeds, {
                tuning: settings?.numericTuning,
                onClamp: ch => toast('warn', `数值校界：${ch.length} 处越界属性已按数值表强制修正`),
                // 剧情指令回写报告：把本轮 AI 写的结构化更新落进快照后的结果
                onCommands: ({ report, droppedRefs }) => {
                  const ids = Object.keys(report || {});
                  const applied = ids.reduce((n, id) => n + (report[id]?.applied?.length || 0), 0);
                  const missed = ids.flatMap(id => (report[id]?.skipped || []));
                  if (applied) toast('ok', `剧情更新已写入存档：${applied} 处 · ${ids.length} 名角色`);
                  if (missed.length) {
                    const head = missed.slice(0, 2).join('；');
                    toast('warn', `${missed.length} 条更新没能生效：${head}${missed.length > 2 ? ` 等共 ${missed.length} 条` : ''}`);
                  }
                  if (droppedRefs?.length) toast('warn', `有 ${droppedRefs.length} 个装备栏的物品名无法识别，已清空该栏`);
                  if (applied || missed.length || droppedRefs?.length) {
                    try { console.debug('[剧情指令]', report, droppedRefs); } catch { /* 忽略 */ }
                  }
                },
              });
              // 持久化合并后的完整快照（而非 AI 返回的精简版）
              const persistBundle = {};
              for (const id of Object.keys(rawSnaps)) persistBundle[id] = nextSave.charSnapshots?.[id];
              persistCharSnapshots(current.id, persistBundle);
              toast('ok', `快照已演化：${Object.keys(rawSnaps).length} 名角色${deeds.length ? ` · ${deeds.length} 条事迹` : ''}`);
            } else {
              toast('warn', '演化结果校验失败，未应用：' + (v.errors[0]?.msg || '未知'));
            }
          } else {
            // ok 但两种结果结构都没命中：AI 回了 200 却没给可用快照。
            // 这里以前什么都不做 —— 正文照常显示，玩家会以为属性也更新了，其实还是上一轮的值。
            toast('warn', '本轮属性未更新：AI 没返回可用的快照内容（存档仍是上一轮的值，正文已保存）');
          }
        } catch (e) {
          if (ac.signal.aborted || e.name === 'AbortError') {
            toast('warn', '已停止：跳过快照演化，正文已保存');
          } else {
            // 服务端把「重写 N 次仍不合规」以 HTTP 502 + error 文案抛回来（见 server/index.js）。
            // 这和网络故障的处置完全不同，文案必须区分，否则玩家会去排查网络。
            const m = String(e.message || e);
            const retried = /已重写\s*\d+\s*次仍不合规/.test(m);
            toast('warn', retried
              ? '本轮属性未更新：AI 反复写不合规的角色数值，已整批丢弃（存档仍是上一轮的值，正文已保存）'
              : '快照演化失败：' + m + ' · 正文已保存');
          }
        }
        }
      } else {
        // ===== 本地模式：先显示用户输入，再生成旁白 =====
        text = turnNarrative(current, actionText, settings?.worldbook || []);
        const parsed = parseStateBlock(text);
        if (parsed.state) {
          text = parsed.text;
          nextSave = applyAIState(current, parsed.state);
        }
        newStory = [...newStory, { turn: newStory.length, role: 'ai', text, timeLabel: current.world.timeLabel }];
        setStory(newStory);
      }

      // ===== 世界时间：交回 AI 自主规划 =====
      // 已取消「每回合固定推进 N 小时」。优先级：正文里最后一个 <scene_checkpoint data-time>
      // → 正文开头 <ui_sys> 的时间 → 演化阶段报出的 worldTime（字符串，需再解析一次）；
      // 都没有则时间保持不变（不猜）。
      const aiTime = extractStoryTime(text) || parseWorldTime(evolveWorldTime);
      if (aiTime) nextSave = applyWorldTime(nextSave, aiTime);

      // 把本回合结束时的完整状态附着到 ai 块（右键「回退」的快照回滚依据）
      const lastIdx = newStory.length - 1;
      if (lastIdx >= 0 && newStory[lastIdx]?.role === 'ai') {
        newStory = [...newStory];
        newStory[lastIdx] = {
          ...newStory[lastIdx],
          timeLabel: nextSave.world?.timeLabel || newStory[lastIdx].timeLabel,
          payload: buildSnapshotPayload(nextSave),
        };
        setStory(newStory);
      }

      const persisted = await persist(newStory, nextSave);

      // ===== 战斗接管：本回合若发出了 <battle> 指令，演化落档后立刻开战 =====
      // 位置放在演化之后：参战角色的快照必须是最新的（本回合新建档的人也在里面），
      // 战斗里用的每一个数字才与角色面板完全同源。
      if (battleIntent) {
        if (settings?.battle?.mode === 'manual') {
          // 指令本身写坏了（不是 JSON）也照样开局：按默认规则打一场，但要把这件事告诉玩家
          if (battleIntent.parseError) toast('warn', `战斗布置指令格式有误（${battleIntent.parseError}），已按默认规则开局`);
          // 同一场的「补地图」与「战斗本身」必须共用一个 seed：地图是程序在补齐空场时
          // 现生成的，两边各摇一次骰子的话，事后排查会看到「同一局的两个不同战场」。
          const battleSeed = Math.floor(Math.random() * 1e9);
          const built = buildBattleFromSpec(nextSave, battleIntent.spec, {
            tuning: settings?.numericTuning,
            floorHpPercent: settings?.battle?.floorHpPercent,
            seed: battleSeed,
            rawText: rawFullText,   // 建档保底：点名的人没档案时，从这里认他的名字（::dialogue 标记）
          });
          if (built.ok) {
            // 校界修正过的快照先落盘，保证战斗里用的数字与角色面板一致
            if (Object.keys(built.clamped || {}).length) {
              nextSave = { ...nextSave, charSnapshots: { ...nextSave.charSnapshots, ...built.clamped } };
              persistCharSnapshots(nextSave.id, built.clamped);
              await persist(newStory, nextSave);
            }
            // 兜底建出来的临时档案也要落盘：这一场他用它参战，之后角色名册里就得有这个人
            // （带 recovered 标记，玩家能在名册里看到并补全）
            if (Object.keys(built.recovered || {}).length) {
              nextSave = { ...nextSave, charSnapshots: { ...nextSave.charSnapshots, ...built.recovered } };
              persistCharSnapshots(nextSave.id, built.recovered);
              await persist(newStory, nextSave);
            }
            const setup = {
              units: built.units,
              mapRecipe: built.mapRecipe,
              kind: built.kind,
              allowDeath: built.allowDeath,
              note: built.note,
              seed: battleSeed,
            };
            setup.state = createBattle(setup);
            setBattle({ setup, note: built.note, warnings: built.warnings, collapsed: false });
            if (built.warnings.length) toast('warn', built.warnings[0]);
            toast('ok', `战斗开始：${describeBattleSetup(built)}`);
          } else {
            toast('err', `战斗未能开始：${built.errors[0] || '参战角色校验未通过'}`);
          }
        } else {
          toast('warn', '正文里出现了战斗布置指令，但「设置 → 战斗模式」是关闭的，已忽略（当前由 AI 自行推演）');
        }
      }

      // 叙事记忆压缩（此前机制缺失——{{narrativeMemory}} 令牌引用了 memories 但从无写入点）。
      // 异步不阻塞回合流程；走快照通道（/api/ai/generate）；失败静默——记忆是增强而非关键路径
      {
        const memCfg = settings?.memory || {};
        const aiTurn = newStory.filter(x => x.role === 'ai').slice(-1)[0];
        const userTurn = newStory.filter(x => x.role === 'user').slice(-1)[0];
        if (memCfg.enabled !== false && aiTurn?.text) {
          const summaryLen = memCfg.summaryLen || 60;
          const recapEvery = memCfg.recapEvery || 10;
          const recapLen = memCfg.recapLen || 150;
          const memMessages = [
            { role: 'system', content: memoryCompressorText(summaryLen) },
            { role: 'user', content: `【用户行动】${String(userTurn?.text || '').slice(0, 300)}\n【本回合正文】${aiTurn.text.slice(0, 3000)}` },
          ];
          api.aiGenerate(memMessages).then(r => {
            const summary = String(r?.text || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
            if (!summary) return;
            const entry = { turn: persisted.turnCount || newStory.length, timeLabel: persisted.world?.timeLabel || '', summary: summary.slice(0, summaryLen + 60) };
            const fullMem = [...(persisted.memories || []), entry];
            // 两级记忆：每满 recapEvery 条回合摘要，自动生成一条阶段总结
            const needRecap = memCfg.recapEnabled !== false && fullMem.length > 0 && fullMem.length % recapEvery === 0;
            const recapTask = needRecap ? api.aiGenerate([
              { role: 'system', content: phaseSummarizerText(recapLen) },
              { role: 'user', content: fullMem.slice(-recapEvery).map(m => `[${m.timeLabel || '第' + m.turn + '回合'}] ${m.summary}`).join('\n') },
            ]).then(r2 => {
              const rs = String(r2?.text || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
              if (!rs) return null;
              const tail = fullMem.slice(-recapEvery);
              return { fromTurn: tail[0]?.turn ?? null, toTurn: entry.turn, turn: entry.turn, summary: rs.slice(0, recapLen + 50) };
            }) : Promise.resolve(null);
            // 服务端读改写追加（同回合去重）——保留条数由设置决定
            return recapTask.then(recap => api.appendMemory(save.id, {
              entry, recap,
              keep: { summaries: memCfg.keepSummaries || 40, recaps: memCfg.keepRecaps || 10 },
            }));
          }).catch(() => {});
        }
      }

      const every = Number(settings?.story?.autoSnapshotEvery) || 0;
      const newCount = persisted.turnCount || 0;
      if (every > 0 && newCount > 0 && newCount % every === 0) {
        api.createSnapshot(save.id, {
          label: `第 ${newCount} 回合 · ${persisted.world?.timeLabel || ''}`,
          source: 'turn',
          summary: snapshotSummaryText(persisted),
          turnCount: newCount,
          timeLabel: persisted.world?.timeLabel || '',
          payload: buildSnapshotPayload(persisted),
        }).catch(() => {});
      }
    } catch (e) {
      toast('err', '回合生成失败：' + e.message);
    } finally {
      setBusy(false);
      setStage('');
      abortRef.current = null;
    }
  }, [busy, battle, save, story, mode, settings, wordRange, persist, toast]);

  // ===== 战斗结束：回写气血/法力 → 让 AI 按战报写正文 → 落档 =====
  // 回写口径与全项目一致：只写「会被战斗消耗」的气血与法力（stats.hp/mp 的 current），
  // 固有战力（物攻/物防/…/脚力/神识）一律不动 —— 战斗过程的所有临时状态都不落库。
  const finishBattle = useCallback(async (outcome) => {
    const cur = battle;
    setBattle(null);
    const bundle = { ...(save.charSnapshots || {}) };
    const touched = {};
    for (const [id, o] of Object.entries(outcome.units || {})) {
      const snap = bundle[id];
      if (!snap) continue;
      // 写回逻辑只有一份实现（battleTrigger.applyBattleOutcome）：先减掉特质 / 装备加成，再落回「自身值」。
      // 否则每打一场，加成就被烙进自身一次（实测：自身 100 ＋ 装备 50，打一场后自身上限变 150）。
      const next = applyBattleOutcome(snap, o, characterAttrMods(save, snap, id));
      bundle[id] = next;
      touched[id] = next;
    }
    let nextSave = { ...save, charSnapshots: bundle };
    try { await persistCharSnapshots(nextSave.id, touched); } catch { /* 落盘失败不阻断正文 */ }

    setBusy(true);
    setStage('story');
    let newStory = [...story];
    const aiTurn = newStory.length;
    newStory.push({ turn: aiTurn, role: 'ai', text: '', timeLabel: nextSave.world?.timeLabel, streaming: true });
    setStory(newStory);
    let text = '';
    try {
      // 战后这一次请求与平时那一回合**同一套口径**：协议（含数值约束）取自设置页，
      // 字数取「自动下回合」右侧那个控件的当前值，末尾再补篇幅/视点两条硬约束。
      const effSettings = { ...settings, textRules: { ...(settings?.textRules || {}), minWords: wordRange.min, maxWords: wordRange.max } };
      const lastAi = [...story].reverse().find(b => b.role === 'ai' && b.text);
      const messages = battleNarrativeMessages(nextSave, outcome, { note: cur?.note || '', before: lastAi?.text || '' }, effSettings);
      const ac = new AbortController();
      abortRef.current = ac;
      let full = '';
      for await (const chunk of api.aiStoryStream(messages, ac.signal)) {
        if (chunk.type === 'delta') {
          full += chunk.text || '';
          newStory = [...newStory];
          newStory[aiTurn] = { ...newStory[aiTurn], text: full, streaming: true };
          setStory(newStory);
        } else if (chunk.type === 'reset') {
          // 与普通回合同口径：服务端提升输出预算重新生成，丢弃半截正文从零接收
          // （2026-09-19 补：此前这里只认 delta/error，服务端发的 reset 被丢弃，
          //   重试产出的内容会拼在上一段半截正文后面，变成一个双头段落。）
          full = '';
          newStory = [...newStory];
          newStory[aiTurn] = { ...newStory[aiTurn], text: '', streaming: true };
          setStory(newStory);
        } else if (chunk.type === 'info') {
          // 与普通回合同口径：把服务端的等待/重试说明显示出来。
          // 上游偶尔会整个挂住（实测同样提示词第一次 90 秒零字节、重试 2.5 秒出首字），
          // 这段提示是玩家在长等待里唯一能看到的反馈，漏掉它界面就是一片空白转圈。
          toast('warn', chunk.text || '');
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error);
        }
      }
      text = full.trim();
    } catch (e) {
      text = `（战斗正文生成失败：${e.message}）`;
    }
    if (!text) text = '（战斗已结束）';
    // 战报始终附在正文块上 —— 即便 AI 写正文失败，玩家也能看到过程
    newStory = [...newStory];
    newStory[aiTurn] = {
      turn: aiTurn, role: 'ai', text, streaming: false,
      battleLog: outcome.logText, timeLabel: nextSave.world?.timeLabel,
      payload: buildSnapshotPayload(nextSave),
    };
    setStory(newStory);
    try {
      await persist(newStory, nextSave);
      toast('ok', `战斗结束：${outcome.resultText}｜气血法力已写入存档`);
    } catch (e) {
      toast('err', '战斗结果落档失败：' + e.message);
    } finally {
      setBusy(false);
      setStage('');
      abortRef.current = null;
    }
  }, [battle, save, story, settings, wordRange, persist, toast]);

  // 自动下回合
  useEffect(() => {
    if (!autoTurn || busy || page !== 'story') return;
    const t = setTimeout(() => doTurn(''), 1200);
    return () => clearTimeout(t);
  }, [autoTurn, busy, story, page, doTurn]);

  const send = () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput('');
    doTurn(t);
  };

  // 停止当前回合：中断正文流式 / 快照演化，保留已生成的部分
  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAutoTurn(false); // 停止的同时退出自动模式
  };

  // ===== 回合右键：回退 / 重新生成（均回滚快照） =====
  const attrs = computeAttrs(save.character);
  const c = save.character;
  const w = save.world;

  // 定位回合边界：返回 { userIdx, aiIdx, userInput, prePayload }
  const turnOf = useCallback((index) => {
    const b = story[index];
    if (!b) return null;
    if (b.role === 'user') {
      let aiIdx = null;
      for (let k = index + 1; k < story.length; k++) {
        if (story[k].role === 'ai') { aiIdx = k; break; }
        if (story[k].role === 'user') break;
      }
      return { userIdx: index, aiIdx, userInput: b.text, prePayload: b.prePayload };
    }
    if (b.role === 'ai') {
      let userIdx = null;
      for (let k = index - 1; k >= 0; k--) {
        if (story[k].role === 'user') { userIdx = k; break; }
        if (story[k].role === 'ai') break; // 属于上一回合
      }
      return {
        userIdx, aiIdx: index,
        userInput: userIdx != null ? story[userIdx].text : '',
        prePayload: userIdx != null ? story[userIdx].prePayload : null,
      };
    }
    return null;
  }, [story]);

  const onStoryContextMenu = (e, index) => {
    const b = story[index];
    if (!b || (b.role !== 'user' && b.role !== 'ai') || b.streaming) return;
    e.preventDefault();
    setCtxMenu({ x: Math.min(e.clientX, window.innerWidth - 150), y: Math.min(e.clientY, window.innerHeight - 110), index });
  };

  // 回退：回到「该回合 AI 已回复后」的状态（回退最后一回合 = 无变化）
  const rollbackTo = async (index) => {
    setCtxMenu(null);
    if (busy) return toast('err', '生成中，请先等待完成或点停止');
    const t = turnOf(index);
    if (t?.aiIdx == null) return toast('warn', '该回合没有已完成的 AI 回复，无法回退');
    if (t.aiIdx >= story.length - 1) return toast('warn', '已是最新回合，回退不产生变化');
    const target = story[t.aiIdx];
    let next = { ...save };
    if (target.payload) {
      next = applySnapshotPayload(save, target.payload); // 快照/世界/物品一并回滚（世界书是公用文件，不参与回滚）
    } else {
      toast('warn', '该回合无状态备份，仅截断正文');
    }
    const kept = story.slice(0, t.aiIdx + 1);
    setStory(kept);
    await persist(kept, next);
    toast('ok', `已回退：保留到第 ${target.turn} 节，该回合 AI 回复后`);
  };

  // 重新生成：回滚到该回合前（含快照），用原输入重跑
  const regenerateAt = async (index) => {
    setCtxMenu(null);
    if (busy) return toast('err', '生成中，请先等待完成或点停止');
    const t = turnOf(index);
    if (!t || t.aiIdx == null) return toast('warn', '该回合没有已完成的 AI 回复，无法重新生成');
    const cutIdx = t.userIdx != null ? t.userIdx : t.aiIdx; // 自动回合无用户输入：截到 ai 块前
    let next = { ...save };
    if (t.prePayload) {
      next = applySnapshotPayload(save, t.prePayload); // 回滚到本回合开始前（世界书是公用文件，不参与回滚）
    } else {
      toast('warn', '该回合前无状态备份，快照按当前状态继续');
    }
    const kept = story.slice(0, cutIdx);
    setStory(kept);
    await persist(kept, next);
    pendingRegen.current = { input: t.userInput || '' };
    toast('ok', '已回滚到该回合前，正在重新生成…');
  };

  // ===== 玩家发言编辑：可编辑任意一层的发送语句 =====
  // 「仅保存」= 只改正文历史里的文字，不重新生成；
  // 「重新发送」= 回滚到该层发言之前（含快照），用新文字重跑该回合，其后内容全部作废重生成。
  const startEdit = useCallback((index) => {
    const b = story[index];
    if (!b || b.role !== 'user') return;
    setCtxMenu(null);
    setEditing({ index, text: b.text });
  }, [story]);

  const saveEdit = async (index, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    const next = story.map((b, i) => (i === index ? { ...b, text: t, edited: true } : b));
    setStory(next);
    setEditing(null);
    await persist(next, save);
    toast('ok', '发言已修改，未重新生成后续内容');
  };

  // 回滚到第 index 层发言之前，并把新文字交给重生成队列（复用「重新生成」通道）
  const rerunFrom = async (index, text) => {
    const b = story[index];
    if (!b || b.role !== 'user') return;
    setEditing(null);
    setAutoTurn(false); // 与自动下回合互斥，避免同一回合并发触发两次生成
    let next = { ...save };
    if (b.prePayload) {
      next = applySnapshotPayload(save, b.prePayload);
    } else {
      toast('warn', '该发言前无状态备份，快照按当前状态继续');
    }
    const kept = story.slice(0, index);
    setStory(kept);
    await persist(kept, next);
    pendingRegen.current = { input: String(text || '').trim() };
  };

  // 重新发送：生成中则排队，等「本轮回答结束」或「点停止」后自动执行
  const resendEdit = (index, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (busy) {
      setQueuedResend({ index, text: t });
      setAutoTurn(false);
      setEditing(null);
      toast('warn', '本轮仍在生成：已排队，本轮结束或停止后自动重新发送');
      return;
    }
    rerunFrom(index, t);
  };

  // 排队中的重新发送：等本轮生成结束/被停止后触发
  useEffect(() => {
    if (busy || !queuedResend || page !== 'story') return;
    const { index, text } = queuedResend;
    setQueuedResend(null);
    rerunFrom(index, text);
  }, [busy, story, page, queuedResend]);

  // 待重生成回合触发（状态更新后再触发，确保 doTurn 闭包拿到回滚后的 save/story）
  useEffect(() => {
    if (busy || !pendingRegen.current || page !== 'story') return;
    const { input } = pendingRegen.current;
    pendingRegen.current = null;
    doTurn(input);
  }, [busy, story, page, doTurn]);

  // 右键菜单选项可用性
  const ctxTarget = ctxMenu ? turnOf(ctxMenu.index) : null;
  const ctxIsLastAi = ctxTarget?.aiIdx != null && ctxTarget.aiIdx >= story.length - 1;

  const navTo = (id) => {
    if (id === 'characters') { setShowChars(true); return; }
    setPage(id);
  };

  return (
    <>
      <div className="top-bar">
        <h1>造化玉碟</h1>
        <span className="save-name">{save.name}</span>
        <span className="spacer" />
        <span className={`save-state ${busy || !saved ? 'pending' : ''}`}>
          <span className="dot" aria-hidden="true" />
          {busy ? (stage === 'evolve' ? '快照演化中…' : '正文生成中…') : saved ? '已保存' : '保存中…'}
        </span>
        <button className="ghost small" onClick={async () => { await persist(story, { ...save, story }); setSavesRefresh(x => x + 1); toast('ok', '存档已保存'); }}>保存</button>
        {/* 主题切换：玄墨（夜）/ 宣纸（昼）。只改 <html data-theme>，不重渲染、不动布局 */}
        <button
          className={`ghost small theme-toggle${theme === 'light' ? ' on-light' : ''}`}
          title={theme === 'dark' ? '切到宣纸（亮色）' : '切到玄墨（深色）'}
          aria-label="切换界面主题"
          onClick={() => setTheme(applyTheme(theme === 'dark' ? 'light' : 'dark'))}
        >
          <span className="theme-mark" aria-hidden="true" />
          {THEMES.find(t => t.id === theme)?.name || '玄墨'}
        </button>
        <button className="ghost small" onClick={onExit}>返回主页</button>
      </div>

      <div className="game-shell">
        {/* 左侧导航栏 */}
        <nav className="game-nav">
          {NAV_ITEMS.map(item => (
            <button key={item.id}
              className={`nav-item ${page === item.id && item.id !== 'characters' ? 'active' : ''} ${item.id === 'characters' && showChars ? 'active' : ''}`}
              onClick={() => navTo(item.id)}>
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.name}</span>
            </button>
          ))}
          <div className="nav-bottom">
            <div className="nav-turn">第 {save.turnCount} 回合</div>
            <div className="nav-time">{w.timeLabel}</div>
          </div>
        </nav>

        {/* 内容区 */}
        <div className="game-content">
          {page === 'story' && (
            <div className="game-layout">
              {/* 故事页：右部信息栏（可收起） */}
              <div className="story-area">
                <div className="story-scroll" ref={scrollRef} onScroll={handleStoryScroll} style={{ '--story-lh': lineHeight }}>
                  {story.map((b, i) => (
                    <div className="story-block" key={i} onContextMenu={e => onStoryContextMenu(e, i)}>
                      <div className="turn-tag">◆ 第 {b.turn} 节 · {b.timeLabel}</div>
                      {b.role === 'ai' ? (
                        // 流式期间同步用 StoryRenderer 渲染（半截运行时标签由渲染器截断，闭合后整块出现）
                        <>
                          <StoryRenderer text={b.text} palette={settings?.textRules?.colorPalette} onPickOption={t => { setInput(t); toast('ok', '已填入发送框，可编辑后发送'); }} />
                          {/* 战报可回顾：正文是 AI 写的「过程」，这里是程序算出来的「账」 */}
                          {b.battleLog && (
                            <details className="battle-report">
                              <summary>⚔ 战斗记录（程序结算）</summary>
                              <pre>{b.battleLog}</pre>
                            </details>
                          )}
                        </>
                      ) : b.role === 'user' && editing?.index === i ? (
                        // ===== 玩家发言编辑态 =====
                        <div className="story-edit">
                          <textarea
                            className="story-edit-area"
                            value={editing.text}
                            autoFocus
                            onChange={e => setEditing(ed => (ed ? { ...ed, text: e.target.value } : ed))}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resendEdit(i, editing.text); }
                            }}
                          />
                          <div className="story-edit-bar">
                            <span className="story-edit-hint">
                              {busy
                                ? '本轮生成中：「重新发送」将在本轮结束或被停止后自动执行'
                                : '重新发送 = 从这条发言起重来，状态回滚到该回合前，其后内容作废重生成'}
                            </span>
                            <button className="ghost small" onClick={() => setEditing(null)}>取消</button>
                            <button className="ghost small"
                              disabled={busy || !editing.text.trim() || editing.text.trim() === b.text}
                              title={busy ? '生成中不能只保存，会被本轮存档写回覆盖' : '只修改文字，不重新生成后续内容'}
                              onClick={() => saveEdit(i, editing.text)}>仅保存</button>
                            <button className="primary small"
                              disabled={!editing.text.trim() || editing.text.trim() === b.text}
                              title="以修改后的内容重新发送 · Ctrl+Enter"
                              onClick={() => resendEdit(i, editing.text)}>重新发送</button>
                          </div>
                        </div>
                      ) : (
                        <div className={`story-text ${b.role}`} style={{ fontSize }}>
                          {b.text}
                          {b.role === 'user' && (
                            <>
                              {b.edited && <span className="edited-mark" title="这条发言修改过">已编辑</span>}
                              <button className="msg-edit-btn" title="编辑这条发送语句"
                                onClick={() => startEdit(i)}>✎ 编辑</button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {busy && <div className="loading-tip"><Spinner /> {stage === 'evolve' ? '快照演化中…' : '正文生成中…'}</div>}
                </div>
                <div className="action-bar">
                  <div className="quick-actions">
                    {QUICK.map(q => (
                      <button key={q} disabled={busy} onClick={() => doTurn(quickActionNarrative(save, q))}>{q}</button>
                    ))}
                    <button className={autoTurn ? 'primary' : ''} onClick={() => setAutoTurn(a => !a)}>{autoTurn ? '停止自动' : '自动下回合'}</button>
                    <span className="word-range-ctl" title="正文字数规范，修改后自动保存并注入 AI 提示词">
                      字数
                      <input
                        type="number" min="50" max="5000" step="50"
                        value={wordRange.min}
                        onChange={e => setWordRange(w => ({ ...w, min: Math.max(50, Math.min(Number(e.target.value) || 200, wordRange.max)) }))}
                        aria-label="最少字数"
                      />
                      <span className="dash">-</span>
                      <input
                        type="number" min="50" max="8000" step="50"
                        value={wordRange.max}
                        onChange={e => setWordRange(w => ({ ...w, max: Math.max(wordRange.min, Math.min(Number(e.target.value) || 400, 8000)) }))}
                        aria-label="最多字数"
                      />
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-faint)', marginLeft: 'auto' }}>
                      {(() => {
                        const se = storyEndpointOf(settings);
                        const ne = snapshotEndpointOf(settings);
                        const diff = !!ne && (!se || ne.id !== se.id);
                        const l = ep => (ep ? (ep.name || '未命名') + (ep.model ? ' · ' + ep.model : '') : '未配置');
                        const body = mode === 'ai' ? '正文 ' + l(se) + (diff ? ' ｜ 快照 ' + l(ne) : '') : '本地旁白引擎';
                        return (
                          <span title={'正文接口：' + l(se) + '\n快照接口：' + l(ne)}>
                            {body}
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                  {queuedResend && (
                    <div className="queued-resend">
                      <span>
                        ⏳ 已排队重新发送：第 {story[queuedResend.index]?.turn ?? '—'} 节发言 · 修改后
                        · 本轮结束或点「停止」后自动执行
                      </span>
                      <button className="ghost small"
                        onClick={() => { setQueuedResend(null); toast('ok', '已取消排队'); }}>取消排队</button>
                    </div>
                  )}
                  <div className="input-row">
                    <textarea
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
                      placeholder={busy ? '生成中…可点击右侧「停止」中断' : '输入你的行动… Ctrl+Enter 发送'}
                    />
                    {busy && mode === 'ai' ? (
                      <button className="danger" onClick={stop} title="中断当前回合：保留已生成正文，跳过快照演化" style={{ alignSelf: 'stretch' }}>停止</button>
                    ) : (
                      <button className="primary" onClick={send} disabled={!input.trim()} style={{ alignSelf: 'stretch' }}>发送</button>
                    )}
                  </div>
                </div>
              </div>

              {/* 右侧信息栏 */}
              <div className="side-panel">
                <Collapsible title="天时地利" defaultOpen>
                  <div className="kv"><span className="k">时间</span><span className="v">{w.timeLabel} {w.season} {w.weather}</span></div>
                  <div className="kv"><span className="k">地点</span><span className="v" style={{ fontSize: 12 }}>{w.location?.name}</span></div>
                  <div className="kv"><span className="k">灵气浓度</span><span className="v">{w.location?.aura ?? '—'}</span></div>
                </Collapsible>
                <Collapsible title="玩家概要" defaultOpen>
                  <button style={{ width: '100%' }} onClick={() => setShowChars(true)}>{c.name} →</button>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{c.gender} · {c.race?.name} · {c.origin?.name}</div>
                </Collapsible>
                <Collapsible title="个人信息" defaultOpen>
                  <div className="kv"><span className="k">境界</span><span className="v">{c.realm?.name}(0%)</span></div>
                  <div className="kv"><span className="k">年龄</span><span className="v">{c.age} 岁</span></div>
                  <div className="kv"><span className="k">寿元</span><span className="v">约 {Math.max(0, (c.realm?.lifespan || 80) - c.age)} 年</span></div>
                </Collapsible>
                <Collapsible title="道基属性" defaultOpen>
                  <SideAttrList save={save} />
                  <div className="kv"><span className="k">灵根</span><span className="v" style={{ fontSize: 12 }}>{rootDisplayName(c.root)}</span></div>
                  <div className="kv"><span className="k">修炼速度</span><span className="v">{Math.round((ROOT_CULTIVATE_RATE[c.root?.typeId] || 0.7) * 100)}%</span></div>
                </Collapsible>
                {(save.plot?.direction || Object.values(save.plot?.styles || {}).some(x => x.selected)) && (
                  <Collapsible title="剧情演化" defaultOpen>
                    {save.plot.direction && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>方向：{save.plot.direction.slice(0, 40)}{save.plot.direction.length > 40 ? '…' : ''}</div>}
                    {PLOT_STYLE_NAMES(save).length > 0 && (
                      <div style={{ cursor: 'pointer' }} onClick={() => setPage('evolution')}>
                        {PLOT_STYLE_NAMES(save).map(n => <span key={n} className="tag">{n}</span>)}
                      </div>
                    )}
                  </Collapsible>
                )}
                {w.factors?.length > 0 && (
                  <Collapsible title="世界因子" defaultOpen>
                    {w.factors.map(f => <span key={f.name} className="tag">{f.name}</span>)}
                  </Collapsible>
                )}
              </div>
            </div>
          )}

          {page === 'evolution' && <EvolutionPage save={save} updateSave={updateSave} saveNow={saveNow} mode={mode} />}
          {page === 'saves' && <SavesManagerPage save={save} onSwitchSave={onSwitchSave} onNewSave={onNewSave} refreshKey={savesRefresh} />}
          {page === 'factors' && <FactorsPage save={save} updateSave={updateSave} saveNow={saveNow} />}
          {page === 'worldbook' && <WorldBookPage worldbook={settings?.worldbook || []} onSave={saveWorldbook} />}
          {page === 'assistant' && <AssistantPage save={save} updateSave={updateSave} saveNow={saveNow} mode={mode} />}
          {page === 'snapshots' && <SnapshotsPage save={save} updateSave={updateSave} saveNow={saveNow} worldbook={settings?.worldbook || []} />}
          {page === 'map' && <MapPage save={save} updateSave={updateSave} saveNow={saveNow} />}
          {page === 'numeric' && (
            <NumericPage save={save} updateSave={updateSave} saveNow={saveNow} settings={settings} onSettingsChange={setSettings} />
          )}
          {page === 'constraints' && (
            <ConstraintsPage settings={settings} onSettingsChange={setSettings} />
          )}
          {page === 'settings' && (
            <SettingsPage settings={settings} onSaved={setSettings} onBack={() => setPage('story')} />
          )}
        </div>
      </div>

      {/* ===== 战斗（程序接管）=====
          覆盖式界面；点「收起」不结束战斗，只把它缩成一条悬浮提示，战斗状态原样保留。 */}
      {battle && !battle.collapsed && (
        <BattleView
          setup={battle.setup}
          onClose={() => setBattle(x => (x ? { ...x, collapsed: true } : x))}
          onFinish={finishBattle}
        />
      )}
      {battle?.collapsed && (
        <button className="battle-chip" onClick={() => setBattle(x => (x ? { ...x, collapsed: false } : x))}>
          <span className="bc-dot" />
          ⚔ 战斗进行中 · 第 {battle.setup.state?.round || 1} 回合 · 点击展开
        </button>
      )}

      {/* 查看人物：右侧滑出面板（不占据全部空间） */}
      {showChars && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowChars(false)} />
          <CharacterPanel save={save} updateSave={updateSave} saveNow={saveNow} onClose={() => setShowChars(false)} settings={settings} />
        </>
      )}

      {/* 回合右键菜单：回退 / 重新生成 */}
      {ctxMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setCtxMenu(null)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }} />
          <div className="turn-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => rollbackTo(ctxMenu.index)} disabled={ctxTarget?.aiIdx == null || ctxIsLastAi}
              title="回到该回合 AI 已回复后的状态，含快照回滚">↩ 回退到此回合后</button>
            <button onClick={() => regenerateAt(ctxMenu.index)} disabled={ctxTarget?.aiIdx == null}
              title="回滚到该回合前并回滚快照，用原输入重新生成">⟳ 重新生成</button>
            {ctxTarget?.userIdx != null && (
              <button onClick={() => startEdit(ctxTarget.userIdx)}
                title="修改本回合的玩家发送语句，可仅保存或直接重新发送">✎ 编辑本次发送语句</button>
            )}
          </div>
        </>
      )}
    </>
  );
}

// 侧栏属性数字列表（读快照 stats + 装备加成）
function SideAttrList({ save }) {
  const c = save.character;
  const snap = save.charSnapshots?.B1 || snapshotFromCharacter(c, {
    id: 'B1', kind: 'player', isPlayer: true, locationName: save.world?.location?.name,
  });
  const rows = attrRows(snap, characterAttrMods(save, snap, 'B1'));
  if (!rows.length) return null;
  return (
    <div className="attr-num-list" style={{ gridTemplateColumns: '1fr' }}>
      {rows.map(r => (
        <div className="attr-num-row" key={r.key}>
          <span className="label">{r.label}</span>
          <span className="nums">
            {r.isPool ? `${r.effCurrent} / ${r.effMax}` : r.effCurrent}
            {!!r.total && (
              <span className={`bonus-total ${r.total > 0 ? 'up' : 'down'}`}
                title={attrBonusHint(r)}>（{r.total > 0 ? '+' : ''}{r.total}）</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Collapsible({ title, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="collapsible">
      <div className="head" onClick={() => setOpen(o => !o)}>
        <span>{title}</span><span>{open ? '−' : '+'}</span>
      </div>
      {open && <div className="body">{children}</div>}
    </div>
  );
}
