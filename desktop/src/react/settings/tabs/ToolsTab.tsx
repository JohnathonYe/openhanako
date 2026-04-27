/**
 * ToolsTab — 设置页「工具」：开启/关闭各工具
 * - 「当前助手」：该助手目录 config 的 tools.disabled（与全局并集）
 * - 「所有助手」：preferences.tools_disabled
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import { hanaFetch } from '../api';

interface ToolEntry {
  id: string;
  label: string;
  kind: string;
}

export function ToolsTab() {
  const { showToast, settingsAgentId, currentAgentId, agents } = useSettingsStore();
  const [toolsScope, setToolsScope] = useState<'agent' | 'global'>('agent');
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [globalDisabled, setGlobalDisabled] = useState<string[]>([]);
  const [scope, setScope] = useState<'global' | 'agent'>('global');
  const [loading, setLoading] = useState(true);

  /** 与「助手」页一致：正在浏览的助手，否则当前主助手 */
  const focusAgentId = settingsAgentId || currentAgentId;
  const focusAgentName =
    agents.find((a) => a.id === focusAgentId)?.name || focusAgentId || '';

  const toolsQuery = useMemo(() => {
    if (toolsScope === 'global' || !focusAgentId) return '';
    return `?agentId=${encodeURIComponent(focusAgentId)}`;
  }, [toolsScope, focusAgentId]);

  const globalDisabledSet = useMemo(() => new Set(globalDisabled), [globalDisabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await hanaFetch(`/api/preferences/tools${toolsQuery}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!cancelled) {
          setTools(data.tools || []);
          setDisabled(Array.isArray(data.disabled) ? data.disabled : []);
          setGlobalDisabled(Array.isArray(data.globalDisabled) ? data.globalDisabled : []);
          setScope(data.scope === 'agent' ? 'agent' : 'global');
        }
      } catch (err: any) {
        if (!cancelled) showToast(err?.message || 'Failed to load tools', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showToast, toolsQuery]);

  const setToolEnabled = async (toolId: string, enabled: boolean) => {
    if (scope === 'agent' && enabled && globalDisabledSet.has(toolId)) {
      showToast(t('settings.tools.lockedByGlobal'), 'error');
      return;
    }
    const next = enabled
      ? disabled.filter((id) => id !== toolId)
      : [...disabled, toolId];
    const prev = disabled;
    setDisabled(next);
    try {
      const res = await hanaFetch(`/api/preferences/tools${toolsQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: next }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      setDisabled(prev);
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
        {focusAgentId ? (
          <div className="settings-field settings-field-center" style={{ marginBottom: 10 }}>
            <div className="model-capsule" style={{ width: '100%', maxWidth: 420 }}>
              <span className="model-capsule-label">{t('settings.tools.appliesTo')}</span>
              <SelectWidget
                value={toolsScope}
                onChange={(v) => setToolsScope(v === 'global' ? 'global' : 'agent')}
                options={[
                  {
                    value: 'agent',
                    label: t('settings.tools.scopeAgent', { name: focusAgentName }),
                  },
                  { value: 'global', label: t('settings.tools.scopeGlobal') },
                ]}
              />
            </div>
          </div>
        ) : null}
        <p className="settings-desc settings-desc-compact">
          {scope === 'agent' ? t('settings.tools.descAgent') : t('settings.tools.desc')}
        </p>
        <div className="tool-caps-group">
          {grouped.map((tool) => {
            const enabled = !disabled.includes(tool.id);
            const canDelete = tool.kind === 'user_script' && scope === 'global';
            const lockGlobal = scope === 'agent' && globalDisabledSet.has(tool.id);
            return (
              <div key={tool.id} className="tool-caps-item">
                <div className="tool-caps-label">
                  <span className="tool-caps-name">{tool.label || tool.id}</span>
                  {kindLabel[tool.kind] && (
                    <span className="tool-caps-desc settings-tools-kind">{kindLabel[tool.kind]}</span>
                  )}
                  {lockGlobal && (
                    <span className="tool-caps-desc settings-tools-kind">{t('settings.tools.globalOffBadge')}</span>
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
