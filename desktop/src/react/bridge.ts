/**
 * Bridge — 旧代码 ↔ Zustand 状态桥
 *
 * 核心机制：app.js 的 state 是 Proxy，React mount 后激活，
 * 读写直接走 Zustand，不再需要双向同步。
 *
 * 每迁移完一个模块，就从 bridge 里移除对应 shim。全部迁完后 bridge 删除。
 */

import { useStore, type StoreState } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import {
  countMediaAttachments,
  guessMediaMimeType,
  isMediaAttachment,
  MAX_MEDIA_ATTACHMENTS,
  MAX_NON_MEDIA_ATTACHMENTS,
} from './utils/format';
import { showHanaToast } from './utils/hana-toast';
import { setupSidebarShim } from './shims/sidebar-shim';
import { setupChannelsShim } from './shims/channels-shim';
import { setupAppMessagesShim } from './shims/app-messages-shim';
import { setupAppAgentsShim } from './shims/app-agents-shim';
import { setupAppWsShim } from './shims/app-ws-shim';
import { setupAppUiShim } from './shims/app-ui-shim';
import { setupArtifactsShim } from './shims/artifacts-shim';
import { setupFileCardsShim } from './shims/file-cards-shim';
import { setupDeskShim } from './shims/desk-shim';
import { setupChatRenderShim } from './shims/chat-render-shim';

function mediaKindFromFileName(name: string): 'image' | 'video' | 'audio' | null {
  const m = guessMediaMimeType(name);
  if (!m) return null;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return null;
}

function toastSessionMediaCached(kindLabels: string): void {
  const raw = typeof window.t === 'function' ? window.t('error.sessionMediaKindCached', { kinds: kindLabels }) : '';
  const msg =
    raw && raw !== 'error.sessionMediaKindCached'
      ? raw
      : `本会话中该模型已不支持此类附件：${kindLabels}`;
  showHanaToast(msg, 'error');
}

function canAddAttachment(store: StoreState, incoming: { name: string; isDirectory?: boolean }): boolean {
  const files = store.attachedFiles;
  const mediaCount = countMediaAttachments(files);
  const nonMediaCount = files.length - mediaCount;
  if (isMediaAttachment(incoming)) {
    return mediaCount < MAX_MEDIA_ATTACHMENTS;
  }
  return nonMediaCount < MAX_NON_MEDIA_ATTACHMENTS;
}

declare global {
  interface Window {
    __hanaActivateProxy: (
      getState: () => StoreState,
      setState: (patch: Partial<StoreState>) => void,
    ) => void;
    __hanaGetState: () => StoreState;
  }
}

/**
 * 激活 Proxy：让 app.js 的 state 对象读写直接走 Zustand
 */
function activateProxy(): void {
  window.__hanaActivateProxy?.(
    () => useStore.getState(),
    (patch) => useStore.setState(patch),
  );
}

/**
 * 兼容 shim：已迁移到 React 的模块仍被旧代码引用
 * sidebar.js 的 switchSession / createNewSession 需要关闭浮动面板
 */
function setupLegacyShims(): void {
  const modules = ((window as unknown as Record<string, unknown>).HanaModules ||= {}) as Record<string, unknown>;

  // activity.js + automation（Phase 3a 迁移到 React）
  if (!modules.activity) {
    modules.activity = {
      isActivityVisible: () => useStore.getState().activePanel === 'activity',
      hideActivityPanel: () => useStore.getState().setActivePanel(null),
      closeActivityDetail: () => { /* detail 由 React 内部 state 管理，关面板即清 */ },
      isAutomationVisible: () => useStore.getState().activePanel === 'automation',
      hideAutomationPanel: () => useStore.getState().setActivePanel(null),
    };
  }

  // bridge.js（Phase 3b 迁移到 React）
  if (!modules.bridge) {
    modules.bridge = {
      isBridgeVisible: () => useStore.getState().activePanel === 'bridge',
      hideBridgePanel: () => useStore.getState().setActivePanel(null),
    };
  }

  // artifacts（Phase 3c）
  setupArtifactsShim(modules);

  // file-cards（Phase 3c）
  setupFileCardsShim(modules);

  // desk（Phase 3d）
  setupDeskShim(modules);

  // chat-render（Phase 3e）— 命令式 DOM 操作，流式高频调用
  setupChatRenderShim(modules);

  // sidebar（Phase 3f）
  setupSidebarShim(modules);

  // channels（Phase 3f）
  setupChannelsShim(modules);

  // app.js 分解（Phase 4）
  setupAppMessagesShim(modules);
  setupAppAgentsShim(modules);
  setupAppWsShim(modules);
  setupAppUiShim(modules);

  // Phase 6A: input shim — 大部分逻辑已移入 React InputArea，
  // 只保留拖拽附件（事件绑定在 mainContent 上，不在 portal 内）
  {
    let dragCounter = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (modules as any).appInput = {
      getAttachedCount: () => useStore.getState().attachedFiles.length,
      getDeskContextAttached: () => useStore.getState().deskContextAttached,
      setDeskContextAttached: (v: boolean) => useStore.getState().setDeskContextAttached(v),
      renderAttachedFiles: () => {},
      sendMessage: () => {},
      stopGeneration: () => {},
      autoResize: () => {},
      initInputListeners: () => {},
      initDeskContextBtn: () => {},
      initAppInput: () => {},
      initDragDrop: () => {
        const mainContent = document.querySelector('.main-content');
        const dropOverlay = document.getElementById('dropOverlay');
        if (!mainContent || !dropOverlay) return;

        mainContent.addEventListener('dragenter', (e) => {
          e.preventDefault();
          dragCounter++;
          if (dragCounter === 1) dropOverlay.classList.add('visible');
        });
        mainContent.addEventListener('dragleave', (e) => {
          e.preventDefault();
          dragCounter--;
          if (dragCounter === 0) dropOverlay.classList.remove('visible');
        });
        mainContent.addEventListener('dragover', (e) => e.preventDefault());
        mainContent.addEventListener('drop', async (e: Event) => {
          e.preventDefault();
          dragCounter = 0;
          dropOverlay.classList.remove('visible');

          const de = e as DragEvent;
          const files = de.dataTransfer?.files;
          if (!files || files.length === 0) return;

          let srcPaths: string[] = [];
          const nameMap: Record<string, string> = {};
          for (const file of Array.from(files)) {
            const filePath = window.platform?.getFilePath?.(file);
            if (filePath) {
              srcPaths.push(filePath);
              nameMap[filePath] = file.name;
            }
          }
          if (srcPaths.length === 0) return;

          // Desk 文件直接附加（保留原始路径，不走 upload）
          // 路径正规化：统一为 / 做比较，兼容 macOS 和 Windows
          const toSlash = (s: string) => s.replace(/\\/g, '/');
          const baseName = (s: string) => s.replace(/\\/g, '/').split('/').pop() || s;
          const s = useStore.getState();
            const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
          if (deskBase) {
            const prefix = deskBase + '/';
            const deskFileMap = new Map(s.deskFiles.map(f => [f.name, f]));
            const isDeskPath = (p: string) => toSlash(p).startsWith(prefix);
            const deskPaths = srcPaths.filter(isDeskPath);
            srcPaths = srcPaths.filter(p => !isDeskPath(p));
            for (const p of deskPaths) {
              const name = baseName(p);
              const knownFile = deskFileMap.get(name);
              const incoming = {
                path: p,
                name,
                isDirectory: knownFile?.isDir ?? false,
              };
              const mk = mediaKindFromFileName(name);
              const sp = useStore.getState().currentSessionPath;
              const mid = useStore.getState().models.find(x => x.isCurrent)?.id;
              if (mk && sp && mid && useStore.getState().isSessionMediaKindRejected(sp, mid, mk)) {
                toastSessionMediaCached(mk === 'image' ? '图片' : mk === 'video' ? '视频' : '音频');
                continue;
              }
              if (!canAddAttachment(useStore.getState(), incoming)) break;
              useStore.getState().addAttachedFile(incoming);
            }
          }
          if (srcPaths.length === 0) return;

          try {
            const res = await hanaFetch('/api/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: srcPaths }),
            });
            const data = await res.json();
            for (const item of (data.uploads || [])) {
              if (item.error) {
                showHanaToast(String(item.error), 'error');
                continue;
              }
              if (item.dest) {
                const incoming = {
                  path: item.dest,
                  name: item.name,
                  isDirectory: item.isDirectory || false,
                };
                const mk2 = mediaKindFromFileName(item.name);
                const sp2 = useStore.getState().currentSessionPath;
                const mid2 = useStore.getState().models.find(x => x.isCurrent)?.id;
                if (mk2 && sp2 && mid2 && useStore.getState().isSessionMediaKindRejected(sp2, mid2, mk2)) {
                  toastSessionMediaCached(mk2 === 'image' ? '图片' : mk2 === 'video' ? '视频' : '音频');
                  continue;
                }
                if (!canAddAttachment(useStore.getState(), incoming)) break;
                useStore.getState().addAttachedFile(incoming);
              }
            }
          } catch (err) {
            console.error('[upload]', err);
            for (const p of srcPaths) {
              const incoming = {
                path: p,
                name: nameMap[p] || p.split('/').pop() || p,
              };
              const mk3 = mediaKindFromFileName(incoming.name);
              const sp3 = useStore.getState().currentSessionPath;
              const mid3 = useStore.getState().models.find(x => x.isCurrent)?.id;
              if (mk3 && sp3 && mid3 && useStore.getState().isSessionMediaKindRejected(sp3, mid3, mk3)) {
                toastSessionMediaCached(mk3 === 'image' ? '图片' : mk3 === 'video' ? '视频' : '音频');
                continue;
              }
              if (!canAddAttachment(useStore.getState(), incoming)) break;
              useStore.getState().addAttachedFile(incoming);
            }
          }
        });
      },
    };
  }
}

/**
 * 初始化 bridge，在 React App mount 时调用
 * 返回 cleanup 函数
 */
export function initBridge(): () => void {
  activateProxy();
  setupLegacyShims();
  window.__hanaGetState = () => useStore.getState();

  return () => { /* cleanup reserved */ };
}
