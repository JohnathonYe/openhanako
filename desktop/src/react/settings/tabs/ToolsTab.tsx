/**
 * ToolsTab — 设置页「工具」：开启/关闭各工具
 * 从 /api/preferences/tools 读写 tools_disabled，新会话生效。
 */
import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { hanaFetch } from '../api';

interface ToolEntry {
  id: string;
  label: string;
  kind: string;
}

export function ToolsTab() {
  const { showToast } = useSettingsStore();
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await hanaFetch('/api/preferences/tools');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!cancelled) {
          setTools(data.tools || []);
          setDisabled(Array.isArray(data.disabled) ? data.disabled : []);
        }
      } catch (err: any) {
        if (!cancelled) showToast(err?.message || 'Failed to load tools', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  const setToolEnabled = async (toolId: string, enabled: boolean) => {
    const next = enabled
      ? disabled.filter((id) => id !== toolId)
      : [...disabled, toolId];
    setDisabled(next);
    try {
      const res = await hanaFetch('/api/preferences/tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: next }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      setDisabled(disabled);
      showToast(err?.message || t('settings.saveFailed'), 'error');
    }
  };

  const deleteTool = async (tool: ToolEntry) => {
    if (tool.kind !== 'user_script') return;
    const name = tool.label || tool.id;
    if (!window.confirm(t('settings.tools.deleteConfirm', { name }))) return;
    try {
      const res = await hanaFetch(`/api/preferences/tools/${encodeURIComponent(tool.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTools((prev) => prev.filter((t) => t.id !== tool.id));
      setDisabled((prev) => prev.filter((id) => id !== tool.id));
      showToast(t('settings.tools.deleted'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('settings.tools.deleteFailed'), 'error');
    }
  };

  if (loading) {
    return (
      <div className="settings-tab-content active" data-tab="tools">
        <div className="settings-section">
          <p className="settings-desc">{t('settings.tools.loading')}</p>
        </div>
      </div>
    );
  }

  const byKind = (a: ToolEntry, b: ToolEntry) => {
    const order = ['builtin', 'custom', 'user_script'];
    const i = order.indexOf(a.kind);
    const j = order.indexOf(b.kind);
    if (i !== j) return i - j;
    return a.id.localeCompare(b.id);
  };

  const grouped = [...tools].sort(byKind);
  const kindLabel: Record<string, string> = {
    builtin: t('settings.tools.kindBuiltin'),
    custom: t('settings.tools.kindCustom'),
    user_script: t('settings.tools.kindUserScript'),
  };

  return (
    <div className="settings-tab-content active" data-tab="tools">
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.tools.title')}</h2>
        <p className="settings-desc settings-desc-compact">
          {t('settings.tools.desc')}
        </p>
        <div className="tool-caps-group">
          {grouped.map((tool) => {
            const enabled = !disabled.includes(tool.id);
            const canDelete = tool.kind === 'user_script';
            return (
              <div key={tool.id} className="tool-caps-item">
                <div className="tool-caps-label">
                  <span className="tool-caps-name">{tool.label || tool.id}</span>
                  {kindLabel[tool.kind] && (
                    <span className="tool-caps-desc settings-tools-kind">{kindLabel[tool.kind]}</span>
                  )}
                </div>
                <div className="tool-caps-actions">
                  <Toggle
                    on={enabled}
                    onChange={(on) => setToolEnabled(tool.id, on)}
                  />
                  {canDelete && (
                    <button
                      type="button"
                      className="settings-tools-delete"
                      title={t('settings.tools.deleteTool')}
                      onClick={() => deleteTool(tool)}
                      aria-label={t('settings.tools.deleteTool')}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
