import React, { useEffect, useRef, useState } from 'react';
import { api, validateReadingSettings } from './api.mjs';
import { ModelSelect } from './model-select.jsx';

const FOLLOW_DSH = 'follow-dsh-default';
const selectedValue = selected => selected ? `${selected.provider}\u0000${selected.model}` : FOLLOW_DSH;

export function ReadingSettings({ dataDirectory, models, modelsState, refreshModels, connected, onVersionMismatch }) {
  const [settings, setSettings] = useState(null); const [value, setValue] = useState(FOLLOW_DSH);
  const [phase, setPhase] = useState('loading'); const [error, setError] = useState(null); const [notice, setNotice] = useState('');
  const mounted = useRef(true); const loading = useRef(null); const mutation = useRef(false);
  const changed = !!settings && value !== selectedValue(settings.defaultModel);
  async function load() {
    if (!connected || mutation.current) return;
    loading.current?.abort(); const controller = new AbortController(); loading.current = controller;
    setPhase('loading'); setError(null); setNotice('');
    const [result] = await Promise.allSettled([api('reading-settings', {}, controller.signal).then(validateReadingSettings), refreshModels()]);
    if (!mounted.current || controller.signal.aborted) return;
    if (result.status === 'fulfilled') { setSettings(result.value); setValue(selectedValue(result.value.defaultModel)); setPhase('ready'); }
    else { setError(result.reason); setPhase('error'); if (result.reason.code === 'VERSION_MISMATCH') onVersionMismatch?.(result.reason); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loading.current?.abort(); }; }, [connected]);
  async function save(resetCorrupt = false) {
    if (!connected || mutation.current || phase !== 'ready' && !(resetCorrupt && error?.code === 'READING_SETTINGS_CORRUPT')) return;
    const [provider, model] = value.split('\u0000');
    const defaultModel = resetCorrupt || value === FOLLOW_DSH ? null : { provider, model };
    mutation.current = true; setPhase('saving'); setError(null); setNotice('');
    try {
      const result = validateReadingSettings(await api('set-default-model', { expectedRevision: resetCorrupt ? 0 : settings.revision, defaultModel }));
      if (!mounted.current) return;
      setSettings(result); setValue(selectedValue(result.defaultModel)); setPhase('ready'); setNotice('已保存，仅用于之后新建的阅读。');
    } catch (failure) { if (mounted.current) { setError(failure); setPhase('error'); if (failure.code === 'VERSION_MISMATCH') onVersionMismatch?.(failure); } }
    finally { mutation.current = false; }
  }
  return <div className="cr-reading-settings">
    <section aria-labelledby="cr-default-model-label"><h3 id="cr-default-model-label">默认阅读代码模型</h3>
      <p className="cr-muted" id="cr-default-model-hint">用于新建阅读，不改变已有会话或 DSH 全局默认。</p>
      <ModelSelect label="默认阅读代码模型" hintId="cr-default-model-hint" missingLabel="已保存的模型" value={value} groups={models?.groups} fallbackOption={{ value: FOLLOW_DSH, label: '跟随 DSH 默认' }} disabled={!connected || phase !== 'ready' || modelsState === 'loading'} loading={phase === 'loading' || modelsState === 'loading'} onValueChange={selected => { setValue(selected); setNotice(''); }} />
      <div className="cr-row cr-settings-actions"><button type="button" className="cr-primary" disabled={!connected || phase !== 'ready' || !changed} onClick={() => void save()}>{phase === 'saving' ? '正在保存…' : '保存设置'}</button><button type="button" aria-label="重新加载模型目录" disabled={!connected || phase === 'loading' || phase === 'saving'} onClick={() => void load()}>重新加载</button></div>
      {!connected && <p className="cr-error" role="alert">请先恢复阅读 Host 连接，再修改设置。</p>}
      {error && <p className="cr-error" role="alert">{error.message}{error.code === 'READING_SETTINGS_CORRUPT' && <button type="button" onClick={() => void save(true)}>重置默认模型</button>}</p>}
      {modelsState === 'error' && <p className="cr-error" role="alert">模型目录加载失败，请重新加载。</p>}
      {models?.failures?.length > 0 && <p className="cr-muted">部分提供方暂不可用，不会自动切换模型。</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
    <section aria-labelledby="cr-archive-location"><h3 id="cr-archive-location">插件档案位置</h3><p className="cr-path cr-archive-path">{dataDirectory || '连接后显示'}</p></section>
  </div>;
}
