import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';
import { GamePage } from './GamePages.jsx';

// 「其它约束」：玩家自填的额外要求，接在所有提示词之后注入。
// 落盘在 settings.extraConstraints，跨存档共用。
export default function ConstraintsPage({ settings, onSettingsChange }) {
  const toast = useToast();
  const saved = String(settings?.extraConstraints || '');
  const [text, setText] = useState(saved);
  const [state, setState] = useState(''); // '' | pending | saved
  const timer = useRef(null);
  const sentRef = useRef(saved); // 最近一次写下去的值，用来忽略自己触发的回传
  const textRef = useRef(text);
  textRef.current = text;

  // 外部设置变化时同步：只认「我们自己没写过」的值，避免打字时被回传打断
  useEffect(() => {
    if (saved === sentRef.current) return;
    sentRef.current = saved;
    setText(saved);
  }, [saved]);

  const write = async (value) => {
    try {
      const next = await api.putSettings({ extraConstraints: value });
      const back = String(next?.extraConstraints || '');
      sentRef.current = back;
      onSettingsChange?.(next);
      setState('saved');
    } catch (e) {
      setState('');
      toast('err', `保存失败：${e.message}`);
    }
  };

  const onChange = (value) => {
    setText(value);
    setState('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => write(value), 700);
  };

  // 离开页面时把还没落盘的改动补写一次
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (textRef.current !== sentRef.current) write(textRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const len = text.trim().length;

  return (
    <GamePage
      title="其它约束"
      footer={(
        <>
          <span className="hint" style={{ margin: 0 }}>
            {len} 字
            {state === 'pending' && ' · 保存中…'}
            {state === 'saved' && ' · 已保存'}
          </span>
        </>
      )}
    >
      <div className="section" style={{ maxWidth: 900 }}>
        <h3>写给 AI 的额外要求</h3>
        <p className="hint">
          这里的内容会接在所有提示词之后，是模型开写之前最后读到的部分，越靠后越容易被遵守。
          想加规则不必改别处的设置，写在这里就行。
        </p>
        <div className="field">
          <label>约束内容 <span className="lbl-note">{len ? '已生效' : '留空则不注入'}</span></label>
          <textarea
            style={{ minHeight: 280 }}
            value={text}
            onChange={e => onChange(e.target.value)}
            placeholder={'一行一条，例如：\n出现的每个角色都要有自己的说话习惯，不要千人一腔。\n主角的决定由我自己给，不要替他做选择。\n不要出现现代网络词与出戏的表达。'}
          />
        </div>
        <div className="hint">
          换行分隔多条，一条说一件事最有效。写完自动保存，切到别的页面也不会丢。
          想调整它在提示词里的位置，可到「设置 → 注入顺序」里的「其它约束」区块调整。
        </div>
      </div>
    </GamePage>
  );
}
