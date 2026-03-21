import React, { useState } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import {
  t, lookupModelMeta, formatContext, autoSaveGlobalModels,
} from '../../helpers';
import { loadSettingsConfig } from '../../actions';
import { SelectWidget } from '../../widgets/SelectWidget';
import { ModelWidget } from '../../widgets/ModelWidget';
import { KeyInput } from '../../widgets/KeyInput';
import styles from '../../Settings.module.css';

function ToolModelTestBtn({ modelId }: { modelId: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const test = async () => {
    if (!modelId) return;
    setStatus('testing');
    try {
      const res = await hanaFetch('/api/models/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      setStatus(data.ok ? 'ok' : 'fail');
    } catch {
      setStatus('fail');
    }
    setTimeout(() => setStatus('idle'), 3000);
  };

  if (!modelId) return null;

  return (
    <button className={`${styles['pv-tool-test-btn']} ${styles[status] || ''}`} onClick={test} disabled={status === 'testing'}>
      {status === 'testing' ? (
        <svg className={styles['spinning']} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      ) : status === 'ok' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : status === 'fail' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )}
    </button>
  );
}

export function OtherModelsSection({ providers }: { providers: Record<string, { models?: string[]; base_url?: string }> }) {
  const { globalModelsConfig, pendingFavorites, showToast } = useSettingsStore();
  const [searchApiKey, setSearchApiKey] = useState('');

  const searchProvider = globalModelsConfig?.search?.provider || '';
  const maskedSearchKey = globalModelsConfig?.search?.api_key;

  const verifySearch = async () => {
    const provider = (globalModelsConfig?.search?.provider || '').trim();
    const apiKey = searchApiKey.trim();
    if (!provider) { showToast(t('settings.search.noProvider'), 'error'); return; }
    if (!apiKey) { showToast(t('settings.search.noKey'), 'error'); return; }
    try {
      const res = await hanaFetch('/api/search/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.search.verified'), 'success');
        await loadSettingsConfig();
      } else {
        showToast(t('settings.search.verifyFailed') + (data.error ? ': ' + data.error : ''), 'error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <>
      <div className={styles['settings-row']}>
        <div className={`${styles['settings-field']} ${styles['settings-field-half']}`}>
          <label className={styles['settings-field-label']}>{t('settings.api.utilityModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              favorites={pendingFavorites}
              value={globalModelsConfig?.models?.utility || ''}
              onSelect={(id) => autoSaveGlobalModels({ models: { utility: id } })}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelId={globalModelsConfig?.models?.utility || ''} />
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.api.utilityModelHint')}</span>
        </div>
        <div className={`${styles['settings-field']} ${styles['settings-field-half']}`}>
          <label className={styles['settings-field-label']}>{t('settings.api.utilityLargeModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              favorites={pendingFavorites}
              value={globalModelsConfig?.models?.utility_large || ''}
              onSelect={(id) => autoSaveGlobalModels({ models: { utility_large: id } })}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelId={globalModelsConfig?.models?.utility_large || ''} />
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.api.utilityLargeModelHint')}</span>
        </div>
      </div>
      <div className={styles['settings-row']}>
        <div className={`${styles['settings-field']} ${styles['settings-field-half']}`}>
          <label className={styles['settings-field-label']}>{t('settings.api.searchProviderField')}</label>
          <SelectWidget
            options={[
              { value: '', label: 'Not configured' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'serper', label: 'Serper (Google)' },
              { value: 'brave', label: 'Brave Search' },
            ]}
            value={searchProvider}
            onChange={(val) => autoSaveGlobalModels({ search: { provider: val } })}
            placeholder={t('settings.api.searchProviderField')}
          />
        </div>
        <div className={`${styles['settings-field']} ${styles['settings-field-half']}`}>
          <label className={styles['settings-field-label']}>{t('settings.api.searchApiKey')}</label>
          <KeyInput
            value={searchApiKey}
            onChange={setSearchApiKey}
            placeholder={maskedSearchKey || t('settings.api.apiKeyPlaceholder')}
          />
          <button className={styles['search-verify-btn']} onClick={verifySearch}>
            {t('settings.search.verify')}
          </button>
          <span className={styles['settings-field-hint']}>{t('settings.api.searchApiKeyHint')}</span>
        </div>
      </div>
    </>
  );
}
