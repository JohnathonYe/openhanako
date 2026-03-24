import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { loadAgents } from '../actions';
import { KeyInput } from '../widgets/KeyInput';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';
import bridgeStyles from './BridgeTab.module.css';

const platform = window.platform;

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
}

interface TelegramStatus extends PlatformStatusBase {
  tokenMasked?: string;
}

interface FeishuStatus extends PlatformStatusBase {
  appId?: string;
  appSecretMasked?: string;
}

interface QQStatus extends PlatformStatusBase {
  appID?: string;
  appSecretMasked?: string;
}

interface WechatStatus extends PlatformStatusBase {
  tokenMasked?: string;
}

interface KnownUser {
  userId: string;
  name?: string;
}

interface BridgeStatus {
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  whatsapp: PlatformStatusBase;
  qq: QQStatus;
  wechat: WechatStatus;
  readOnly: boolean;
  /** 非空时固定使用该助手处理社交平台消息；空则跟随主窗口当前助手 */
  ownerAgentId?: string;
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; whatsapp?: string; qq?: string; wechat?: string };
}

type BridgePlatform = 'telegram' | 'feishu' | 'whatsapp' | 'qq' | 'wechat';

export function BridgeTab() {
  const store = useSettingsStore();
  const { showToast, agents } = store;
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [testingPlatform, setTestingPlatform] = useState<BridgePlatform | null>(null);

  // Public Ishiki
  const [publicIshiki, setPublicIshiki] = useState('');
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState('');

  useEffect(() => {
    const agentId = store.getSettingsAgentId();
    if (!agentId) return;
    hanaFetch(`/api/agents/${agentId}/public-ishiki`)
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => console.warn('[bridge] fetch public-ishiki failed:', err));
  }, [store.settingsConfig]);

  const savePublicIshiki = async () => {
    const agentId = store.getSettingsAgentId();
    if (!agentId || publicIshiki === publicIshikiOriginal) return;
    try {
      await hanaFetch(`/api/agents/${agentId}/public-ishiki`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicIshiki }),
      });
      setPublicIshikiOriginal(publicIshiki);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  // Telegram fields
  const [tgToken, setTgToken] = useState('');
  // Feishu fields
  const [fsAppId, setFsAppId] = useState('');
  const [fsAppSecret, setFsAppSecret] = useState('');
  // QQ fields
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');

  const isMasked = (v: string) => v.includes('••••');

  const loadStatus = async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatus(data);
      // 回填非敏感值
      if (data.feishu?.appId) setFsAppId(data.feishu.appId);
      if (data.qq?.appID) setQqAppId(data.qq.appID);
      // 回填遮掩值到输入框（让用户看到"已保存"）
      setTgToken(data.telegram?.tokenMasked || '');
      setFsAppSecret(data.feishu?.appSecretMasked || '');
      setQqAppSecret(data.qq?.appSecretMasked || '');
    } catch (err) {
      console.error('[bridge] load status failed:', err);
    }
  };

  useEffect(() => {
    loadStatus();
    void loadAgents();
  }, []);

  // 扫码 overlay 成功后触发刷新
  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('hana-bridge-reload', handler);
    return () => window.removeEventListener('hana-bridge-reload', handler);
  }, []);

  const saveBridgeConfig = async (platform_: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    try {
      await hanaFetch('/api/bridge/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, credentials, enabled }),
      });
      showToast(t('settings.saved'), 'success');
      await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (platform_: BridgePlatform, credentials: Record<string, string>) => {
    setTestingPlatform(platform_);
    try {
      const res = await hanaFetch('/api/bridge/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, credentials }),
      });
      const data = await res.json();
      if (data.ok) {
        const info = platform_ === 'telegram' ? ` @${data.info?.username || ''}` : '';
        showToast(t('settings.bridge.testOk') + info, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setTestingPlatform(null);
    }
  };

  const setOwner = async (platform_: string, userId: string) => {
    try {
      await hanaFetch('/api/bridge/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform_, userId: userId || null }),
      });
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const tgInfo = status?.telegram || {};
  const fsInfo = status?.feishu || {};
  const waInfo = status?.whatsapp || {};
  const qqInfo = status?.qq || {};
  const wxInfo = status?.wechat || {};
  const readOnly = !!status?.readOnly;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      {/* 对外意识 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.agent.publicIshiki')}</h2>
        <div className={styles['settings-field']}>
          <textarea
            className={styles['settings-textarea']}
            rows={6}
            spellCheck={false}
            value={publicIshiki}
            onChange={(e) => setPublicIshiki(e.target.value)}
            onBlur={savePublicIshiki}
          />
          <span className={styles['settings-field-hint']}>{t('settings.agent.publicIshikiHint')}</span>
        </div>
      </section>

      {/* 社交平台回复助手（preferences.bridge.ownerAgentId） */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.replyAgent')}</h2>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.replyAgentLabel')}</label>
          <select
            className={styles['settings-input']}
            value={status?.ownerAgentId || ''}
            onChange={async (e) => {
              const v = e.target.value.trim();
              try {
                await hanaFetch('/api/bridge/settings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ownerAgentId: v || null }),
                });
                showToast(t('settings.saved'), 'success');
                await loadStatus();
              } catch {
                showToast(t('settings.saveFailed'), 'error');
              }
            }}
          >
            <option value="">{t('settings.bridge.replyAgentSameAsMain')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id}</option>
            ))}
          </select>
          <span className={styles['settings-field-hint']}>{t('settings.bridge.replyAgentHint')}</span>
        </div>
      </section>

      {/* 教程链接 */}
      <div className="bridge-help-link-row">
        <span
          className="bridge-help-link"
          onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}
        >
          {t('settings.bridge.howTo')}
        </span>
      </div>

      {/* Telegram */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.telegram')}</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={tgInfo.status} />
          <BridgeStatusText status={tgInfo.status} error={tgInfo.error} />
          <Toggle
            on={!!tgInfo.enabled}
            onChange={async (on) => {
              const hasRealToken = tgToken && !isMasked(tgToken);
              const hasSaved = !!status?.telegram?.tokenMasked;
              if (on && !hasRealToken && !hasSaved) {
                showToast(t('settings.bridge.noToken'), 'error');
                return;
              }
              await saveBridgeConfig('telegram', hasRealToken ? { token: tgToken } : null, on);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.telegramToken')}</label>
          <div className="bridge-input-row">
            <KeyInput
              value={tgToken}
              onChange={setTgToken}
              placeholder=""
              onBlur={async () => {
                const trimmed = tgToken.trim();
                if (trimmed && !isMasked(trimmed)) await saveBridgeConfig('telegram', { token: trimmed }, undefined);
              }}
            />
            <button
              className="bridge-test-btn"
              disabled={testingPlatform === 'telegram'}
              onClick={() => {
                const trimmed = tgToken.trim();
                if (!trimmed || isMasked(trimmed)) { showToast(t('settings.bridge.noToken'), 'error'); return; }
                testPlatform('telegram', { token: trimmed });
              }}
            >
              {testingPlatform === 'telegram' ? '...' : t('settings.bridge.test')}
            </button>
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.bridge.telegramHint')}</span>
        </div>
        <OwnerSelect
          platform_="telegram"
          users={status?.knownUsers?.telegram || []}
          currentOwner={status?.owner?.telegram}
          onChange={(userId) => setOwner('telegram', userId)}
        />
      </section>

      {/* 飞书 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.feishu')}</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={fsInfo.status} />
          <BridgeStatusText status={fsInfo.status} error={fsInfo.error} />
          <Toggle
            on={!!fsInfo.enabled}
            onChange={async (on) => {
              const hasSaved = !!fsInfo.appSecretMasked;
              const hasRealSecret = fsAppSecret && !isMasked(fsAppSecret);
              if (on && !hasRealSecret && !hasSaved) {
                showToast(t('settings.bridge.noCredentials'), 'error');
                return;
              }
              const creds: Record<string, string> | null = hasRealSecret ? { appId: fsAppId, appSecret: fsAppSecret } : (fsAppId ? { appId: fsAppId } : null);
              await saveBridgeConfig('feishu', creds, on);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.feishuAppId')}</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={fsAppId}
            onChange={(e) => setFsAppId(e.target.value)}
            onBlur={async () => {
              if (fsAppId.trim() && fsAppSecret.trim() && !isMasked(fsAppSecret)) {
                await saveBridgeConfig('feishu', { appId: fsAppId.trim(), appSecret: fsAppSecret.trim() }, undefined);
              }
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.feishuAppSecret')}</label>
          <div className="bridge-input-row">
            <KeyInput
              value={fsAppSecret}
              onChange={setFsAppSecret}
              placeholder=""
              onBlur={async () => {
                if (fsAppId.trim() && fsAppSecret.trim() && !isMasked(fsAppSecret)) {
                  await saveBridgeConfig('feishu', { appId: fsAppId.trim(), appSecret: fsAppSecret.trim() }, undefined);
                }
              }}
            />
            <button
              className="bridge-test-btn"
              disabled={testingPlatform === 'feishu'}
              onClick={() => {
                if (!fsAppId.trim() || !fsAppSecret.trim() || isMasked(fsAppSecret)) { showToast(t('settings.bridge.noCredentials'), 'error'); return; }
                testPlatform('feishu', { appId: fsAppId.trim(), appSecret: fsAppSecret.trim() });
              }}
            >
              {testingPlatform === 'feishu' ? '...' : t('settings.bridge.test')}
            </button>
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.bridge.feishuHint')}</span>
        </div>
        <OwnerSelect
          platform_="feishu"
          users={status?.knownUsers?.feishu || []}
          currentOwner={status?.owner?.feishu}
          onChange={(userId) => setOwner('feishu', userId)}
        />
      </section>

      {/* QQ */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>QQ</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={qqInfo.status} />
          <BridgeStatusText status={qqInfo.status} error={qqInfo.error} />
          <Toggle
            on={!!qqInfo.enabled}
            onChange={async (on) => {
              const hasSaved = !!(qqInfo.appID && qqInfo.appSecretMasked);
              const hasRealCreds = qqAppId && qqAppSecret && !isMasked(qqAppSecret);
              if (on && !hasRealCreds && !hasSaved) {
                showToast(t('settings.bridge.noCredentials'), 'error');
                return;
              }
              const creds = hasRealCreds ? { appID: qqAppId, appSecret: qqAppSecret } : null;
              await saveBridgeConfig('qq', creds, on);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.qqAppId')}</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={qqAppId}
            onChange={(e) => setQqAppId(e.target.value)}
            onBlur={async () => {
              if (qqAppId.trim() && qqAppSecret.trim() && !isMasked(qqAppSecret)) {
                await saveBridgeConfig('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() }, undefined);
              }
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.bridge.qqAppSecret')}</label>
          <div className="bridge-input-row">
            <KeyInput
              value={qqAppSecret}
              onChange={setQqAppSecret}
              placeholder=""
              onBlur={async () => {
                if (qqAppId.trim() && qqAppSecret.trim() && !isMasked(qqAppSecret)) {
                  await saveBridgeConfig('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() }, undefined);
                }
              }}
            />
            <button
              className="bridge-test-btn"
              disabled={testingPlatform === 'qq'}
              onClick={() => {
                if (!qqAppId.trim() || !qqAppSecret.trim() || isMasked(qqAppSecret)) { showToast(t('settings.bridge.noCredentials'), 'error'); return; }
                testPlatform('qq', { appID: qqAppId.trim(), appSecret: qqAppSecret.trim() });
              }}
            >
              {testingPlatform === 'qq' ? '...' : t('settings.bridge.test')}
            </button>
          </div>
          <span className={styles['settings-field-hint']}>{t('settings.bridge.qqHint')}</span>
        </div>
        <OwnerSelect
          platform_="qq"
          users={status?.knownUsers?.qq || []}
          currentOwner={status?.owner?.qq}
          onChange={(userId) => setOwner('qq', userId)}
        />
      </section>

      {/* 微信 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.wechat')}</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={wxInfo.status} />
          <BridgeStatusText status={wxInfo.status} error={wxInfo.error} />
          <Toggle
            on={!!wxInfo.enabled}
            onChange={async (on) => {
              if (on && !wxInfo.tokenMasked) {
                showToast(t('settings.bridge.wechatNeedScan'), 'error');
                return;
              }
              await saveBridgeConfig('wechat', null, on);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          {wxInfo.tokenMasked ? (
            <div className={bridgeStyles['wechat-logged-in']}>
              <span className={bridgeStyles['wechat-login-info']}>
                {t('settings.bridge.wechatLoggedIn')}: {wxInfo.tokenMasked}
              </span>
              <div className={bridgeStyles['wechat-btn-row']}>
                <button
                  className="bridge-test-btn"
                  onClick={() => window.dispatchEvent(new Event('hana-show-wechat-qrcode'))}
                >
                  {t('settings.bridge.wechatRescan')}
                </button>
                <button
                  className="bridge-test-btn"
                  onClick={async () => {
                    try {
                      await Promise.all([
                        hanaFetch('/api/bridge/config', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ platform: 'wechat', credentials: { botToken: '' }, enabled: false }),
                        }),
                        hanaFetch('/api/bridge/owner', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ platform: 'wechat', userId: null }),
                        }),
                      ]);
                      showToast(t('settings.bridge.wechatUnbound'), 'success');
                    } catch {
                      showToast(t('settings.saveFailed'), 'error');
                    }
                    await loadStatus();
                  }}
                >
                  {t('settings.bridge.wechatUnbind')}
                </button>
              </div>
            </div>
          ) : (
            <div className={bridgeStyles['wechat-scan-row']}>
              <button
                className="bridge-test-btn"
                onClick={() => window.dispatchEvent(new Event('hana-show-wechat-qrcode'))}
              >
                {t('settings.bridge.wechatScan')}
              </button>
            </div>
          )}
          <span className={styles['settings-field-hint']}>{t('settings.bridge.wechatHint')}</span>
        </div>
      </section>

      {/* WhatsApp */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>WhatsApp</h2>
        <div className="bridge-platform-header">
          <BridgeStatusDot status={waInfo.status} />
          <BridgeStatusText status={waInfo.status} error={waInfo.error} />
          <Toggle
            on={!!waInfo.enabled}
            onChange={async (on) => {
              await saveBridgeConfig('whatsapp', null, on);
            }}
          />
        </div>
        <div className={styles['settings-field']}>
          <span className={styles['settings-field-hint']}>{t('settings.bridge.whatsappHint')}</span>
        </div>
        <OwnerSelect
          platform_="whatsapp"
          users={status?.knownUsers?.whatsapp || []}
          currentOwner={status?.owner?.whatsapp}
          onChange={(userId) => setOwner('whatsapp', userId)}
        />
      </section>

      {/* 只读模式 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.bridge.readOnly')}</h2>
        <div className="bridge-platform-header">
          <span className="bridge-readonly-desc">{t('settings.bridge.readOnlyDesc')}</span>
          <Toggle
            on={readOnly}
            onChange={async (on) => {
              try {
                await hanaFetch('/api/bridge/settings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ readOnly: on }),
                });
                showToast(t('settings.saved'), 'success');
                await loadStatus();
              } catch {
                showToast(t('settings.saveFailed'), 'error');
              }
            }}
          />
        </div>
      </section>
    </div>
  );
}

function BridgeStatusDot({ status }: { status?: string }) {
  let cls = 'bridge-status-dot';
  if (status === 'connected') cls += ' bridge-dot-ok';
  else if (status === 'error') cls += ' bridge-dot-err';
  else cls += ' bridge-dot-off';
  return <span className={cls} />;
}

function BridgeStatusText({ status, error }: { status?: string; error?: string }) {
  let text = t('settings.bridge.disconnected');
  if (status === 'connected') text = t('settings.bridge.connected');
  else if (status === 'error') text = t('settings.bridge.error') + (error ? `: ${error}` : '');
  return <span className="bridge-status-text">{text}</span>;
}

function OwnerSelect({ platform_, users, currentOwner, onChange }: {
  platform_: string; users: KnownUser[]; currentOwner?: string; onChange: (userId: string) => void;
}) {
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const handleChange = (value: string) => {
    if (!value) {
      onChange(value);
      return;
    }
    setPendingUserId(value);
  };

  const confirm = () => {
    if (pendingUserId !== null) {
      onChange(pendingUserId);
      setPendingUserId(null);
    }
  };

  const cancel = () => setPendingUserId(null);

  return (
    <div className={`${styles['settings-field']} ${'bridge-owner-field'}`}>
      <label className={`${styles['settings-field-label']} ${'bridge-owner-label'}`}>{t('settings.bridge.ownerSelect')}</label>
      <p className="bridge-owner-warning">{t('settings.bridge.ownerWarning')}</p>
      <select
        className={`${styles['settings-input']} ${'bridge-owner-select'}`}
        value={currentOwner || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={users.length === 0}
      >
        <option value="">{users.length > 0 ? '—' : t('settings.bridge.ownerNone')}</option>
        {users.map((u) => (
          <option key={u.userId} value={u.userId}>{u.name || u.userId}</option>
        ))}
      </select>

      {pendingUserId !== null && (
        <div className={`${styles['memory-confirm-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div className={styles['memory-confirm-card']}>
            <p className={styles['memory-confirm-text']}>
              {t('settings.bridge.ownerConfirmText')}
            </p>
            <div className={styles['memory-confirm-actions']}>
              <button className={styles['memory-confirm-cancel']} onClick={cancel}>
                {t('settings.bridge.ownerConfirmCancel')}
              </button>
              <button className={styles['memory-confirm-primary']} onClick={confirm}>
                {t('settings.bridge.ownerConfirmSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
