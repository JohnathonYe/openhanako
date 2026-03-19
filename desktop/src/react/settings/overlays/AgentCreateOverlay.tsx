import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { switchToAgent } from '../actions';

const platform = (window as any).platform;

type CreateBusyPhase = 'post' | 'switch';

export function AgentCreateOverlay() {
  const { showToast } = useSettingsStore();
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [yuan, setYuan] = useState('hanako');
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState<CreateBusyPhase>('post');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => {
      setName('');
      setYuan('hanako');
      setBusy(false);
      setBusyPhase('post');
      setVisible(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('hana-show-agent-create', handler);
    return () => window.removeEventListener('hana-show-agent-create', handler);
  }, []);

  const close = () => {
    if (busy) return;
    setVisible(false);
  };

  const create = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { showToast(t('settings.agent.nameRequired'), 'error'); return; }

    setBusy(true);
    setBusyPhase('post');
    try {
      const res = await hanaFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, yuan }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      platform?.settingsChanged?.('agent-created', { agentId: data.id, name: data.name });

      setBusyPhase('switch');
      const switched = await switchToAgent(data.id, { skipSuccessToast: true });
      if (!switched) return;

      setVisible(false);
      showToast(t('settings.agent.createdReady', { name: data.name }), 'success');
    } catch (err: any) {
      showToast(t('settings.agent.createFailed') + ': ' + err.message, 'error');
    } finally {
      setBusy(false);
      setBusyPhase('post');
    }
  };

  if (!visible) return null;

  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, any][];

  const statusKey =
    busyPhase === 'post' ? 'settings.agent.creating' : 'settings.agent.switchingAfterCreate';

  return (
    <div
      className={`agent-create-overlay visible${busy ? ' agent-create-overlay-busy' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className={`agent-create-card${busy ? ' agent-create-card-busy' : ''}`}>
        <h3 className="agent-create-title">{t('settings.agent.createTitle')}</h3>
        <div className="settings-field">
          <input
            ref={inputRef}
            className="settings-input"
            type="text"
            placeholder={t('settings.agent.namePlaceholder')}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) { e.preventDefault(); create(); }
              if (e.key === 'Escape') close();
            }}
          />
        </div>
        <div className="settings-field">
          <div className={`yuan-selector${busy ? ' yuan-selector-disabled' : ''}`}>
            <div className="yuan-chips">
              {entries.filter(([key]) => key !== 'kong').map(([key, meta]) => (
                <button
                  key={key}
                  className={`yuan-chip${key === yuan ? ' selected' : ''}`}
                  type="button"
                  disabled={busy}
                  onClick={() => setYuan(key)}
                >
                  <img className="yuan-chip-avatar" src={`assets/${meta.avatar || 'Hanako.png'}`} draggable={false} />
                  <div className="yuan-chip-info">
                    <span className="yuan-chip-name">{key}</span>
                    <span className="yuan-chip-desc">{meta.label || ''}</span>
                  </div>
                </button>
              ))}
            </div>
            {entries.filter(([key]) => key === 'kong').map(([key, meta]) => (
              <button
                key={key}
                className={`yuan-chip${key === yuan ? ' selected' : ''}`}
                type="button"
                disabled={busy}
                onClick={() => setYuan(key)}
              >
                <img className="yuan-chip-avatar" src={`assets/${meta.avatar || 'Hanako.png'}`} draggable={false} />
                <div className="yuan-chip-info">
                  <span className="yuan-chip-name">{key}</span>
                  <span className="yuan-chip-desc">{meta.label || ''}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="agent-create-actions">
          <button type="button" className="agent-create-cancel" onClick={close} disabled={busy}>
            {t('settings.agent.cancel')}
          </button>
          <button type="button" className="agent-create-confirm" onClick={create} disabled={busy}>
            {busy ? (
              <>
                <span className="agent-create-spinner" aria-hidden />
                <span>{t('settings.agent.pleaseWait')}</span>
              </>
            ) : (
              t('settings.agent.confirm')
            )}
          </button>
        </div>
        {busy ? (
          <p className="agent-create-status" role="status" aria-live="polite">
            {t(statusKey)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
