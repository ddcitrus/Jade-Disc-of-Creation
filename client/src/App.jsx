import React, { useState, useEffect, useCallback, useRef } from 'react';
import Splash from './pages/Splash.jsx';
import CreateWizard from './pages/CreateWizard.jsx';
import GameDashboard from './pages/GameDashboard.jsx';
import SavesPage from './pages/SavesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import { api } from './api.js';
import { alignCharSnapshots } from './saveModel.js';
import { ToastProvider, ConfirmProvider } from './ui.jsx';

export default function App() {
  const [page, setPage] = useState('splash'); // splash|create|game|saves|settings
  const [currentSave, setCurrentSave] = useState(null);
  const [settings, setSettings] = useState(null);
  // 当前正在查看的存档 id。切换存档时上一条存档可能在后台继续收尾（写盘、流式正文），
  // 这些写入必须照常落盘，但不能把视图拽回旧存档——所以同步视图前要核对 id。
  const activeIdRef = useRef(null);

  useEffect(() => { api.getSettings().then(setSettings).catch(() => {}); }, []);

  const openSave = useCallback((save) => { activeIdRef.current = save.id; setCurrentSave(save); setPage('game'); }, []);
  const updateSave = useCallback((save) => {
    if (activeIdRef.current !== save.id) return;
    setCurrentSave(save);
  }, []);
  const saveNow = useCallback(async (save) => {
    const s = { ...save, updatedAt: Date.now() };
    await api.saveGame(s);
    if (activeIdRef.current === s.id) setCurrentSave(s);
    // 存档落盘后，把服务端各角色快照按集合对齐（多出来的删掉）。
    // 放在这里是因为它是唯一落盘出口：回退 / 重新生成 / 恢复人生快照都会经由它，
    // 而这些回滚会把存档里的角色集合缩回旧版本 —— 只增不删会在 char_snaps 里留下孤儿。
    await alignCharSnapshots(s.id, s.charSnapshots);
    return s;
  }, []);
  // 新建存档：初始化完成立即落盘（不等完成第一个回合）
  const createdSave = useCallback(async (save) => {
    activeIdRef.current = save.id;
    try {
      await saveNow(save);
    } catch {
      setCurrentSave(save); // 首次落盘失败不阻塞进入游戏，后续回合 persist 会重试
    }
    setPage('game');
  }, [saveNow]);

  let content;
  if (page === 'splash') {
    content = <Splash setPage={setPage} />;
  } else if (page === 'create') {
    content = <CreateWizard settings={settings} onCreated={createdSave} onBack={() => setPage('splash')} />;
  } else if (page === 'saves') {
    content = <SavesPage onOpen={openSave} onBack={() => setPage('splash')} />;
  } else if (page === 'settings') {
    content = (
      <SettingsPage
        settings={settings}
        onSaved={setSettings}
        onBack={() => setPage(currentSave ? 'game' : 'splash')}
      />
    );
  } else if (page === 'game' && currentSave) {
    content = (
      <GameDashboard
        key={currentSave.id}
        save={currentSave}
        updateSave={updateSave}
        saveNow={saveNow}
        onExit={() => setPage('splash')}
        onSwitchSave={(s) => { activeIdRef.current = s.id; setCurrentSave(s); }}
        onNewSave={() => { activeIdRef.current = null; setCurrentSave(null); setPage('create'); }}
      />
    );
  } else {
    content = <Splash setPage={setPage} />;
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app-shell">{content}</div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
