/**
 * ToolGroupBlock — 工具调用组，含展开/折叠、diff 展示、回滚按钮
 */

import { memo, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import styles from './Chat.module.css';
import { extractToolDetail, extractToolDetailFull } from '../../utils/message-parser';
import type { ToolCall } from '../../stores/chat-types';
import { DiffView } from './DiffView';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { toolFilePath } from '../../utils/file-change-collect';

const FILE_MOD_TOOLS = new Set(['write', 'edit', 'edit-diff']);

function toolDiffString(tool: ToolCall): string | null {
  const d = tool.details?.diff;
  return typeof d === 'string' && d.length > 0 ? d : null;
}

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
  turnId?: string;
  sessionPath?: string;
}

function getToolLabel(name: string, phase: string, agentNameOverride?: string): string {
  const t = window.t;
  const agentName = agentNameOverride || useStore.getState().agentName || 'Hanako';
  const vars = { name: agentName };
  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;
  return t?.(`tool._fallback.${phase}`, vars) || name;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, collapsed: initialCollapsed, agentName, turnId, sessionPath }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => setCollapsed(v => !v), []);
  const [reverted, setReverted] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [changePanelOpen, setChangePanelOpen] = useState(false);

  const turnRevertedInStore = useStore(s =>
    sessionPath && turnId ? !!s.revertedTurnIdsBySession[sessionPath]?.[turnId] : false,
  );
  const effectiveReverted = reverted || turnRevertedInStore;

  const allDone = tools.every(t => t.done);
  const failCount = tools.filter(t => t.done && !t.success).length;
  const isSingle = tools.length === 1;

  const hasFileChanges = tools.some(t => FILE_MOD_TOOLS.has(t.name) && t.done && t.success);
  const fileModToolsDone = tools.filter(t => FILE_MOD_TOOLS.has(t.name) && t.done && t.success);
  const suppressInlineDiff = hasFileChanges;

  const handleRevert = useCallback(async () => {
    if (!turnId || reverting || effectiveReverted || !sessionPath) return;
    setReverting(true);
    try {
      const res = await hanaFetch('/api/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId }),
      });
      const data = await res.json();
      if (data.ok) {
        setReverted(true);
        useStore.getState().markTurnReverted(sessionPath, turnId);
      }
    } catch { /* ignore */ }
    setReverting(false);
  }, [turnId, reverting, effectiveReverted, sessionPath]);

  const _t = window.t ?? ((p: string) => p);
  let summaryText = '';
  if (allDone) {
    if (failCount > 0) {
      summaryText = _t('toolGroup.countWithFail', { total: tools.length, fail: failCount });
    } else {
      summaryText = _t('toolGroup.count', { n: tools.length });
    }
  } else {
    const running = tools.filter(t => !t.done).length;
    summaryText = _t('toolGroup.running', { n: running });
  }

  return (
    <div className={`${styles.toolGroup}${isSingle ? ` ${styles.toolGroupSingle}` : ''}`}>
      {!isSingle && (
        <div
          className={`${styles.toolGroupSummary}${allDone ? ` ${styles.toolGroupSummaryClickable}` : ''}`}
          onClick={allDone ? toggle : undefined}
        >
          <span className={styles.toolGroupTitle}>{summaryText}</span>
          {allDone && <span className={styles.toolGroupArrow}>{collapsed ? '›' : '‹'}</span>}
          {!allDone && (
            <span className={styles.toolDots}><span /><span /><span /></span>
          )}
        </div>
      )}
      <div className={`${styles.toolGroupContent}${collapsed && !isSingle ? ` ${styles.toolGroupContentCollapsed}` : ''}`}>
        {tools.map((tool, i) => (
          <ToolIndicator key={`${tool.name}-${i}`} tool={tool} agentName={agentName} suppressInlineDiff={suppressInlineDiff} />
        ))}
        {changePanelOpen && fileModToolsDone.length > 0 && (
          <div className={styles.toolGroupDiffPanel}>
            {fileModToolsDone.map((tool, i) => {
              const fp = toolFilePath(tool);
              const diff = toolDiffString(tool);
              if (diff) {
                return <DiffView key={`d-${tool.name}-${i}`} diff={diff} filePath={fp} />;
              }
              return fp
                ? (
                    <div key={`p-${tool.name}-${i}`} className={styles.toolGroupFilePathOnly} title={fp}>
                      {fp.split('/').pop() || fp}
                    </div>
                  )
                : null;
            })}
          </div>
        )}
        {allDone && hasFileChanges && turnId != null && (
          <div className={styles.toolGroupActions}>
            {!changePanelOpen && !effectiveReverted && (
              <button
                type="button"
                className={styles.viewChangesBtn}
                onClick={() => setChangePanelOpen(true)}
              >
                {_t('toolGroup.viewChanges') !== 'toolGroup.viewChanges'
                  ? _t('toolGroup.viewChanges')
                  : 'View'}
              </button>
            )}
            {changePanelOpen && !effectiveReverted && (
              <button
                type="button"
                className={styles.revertBtn}
                onClick={handleRevert}
                disabled={reverting || !sessionPath}
              >
                {reverting
                  ? '...'
                  : (_t('toolGroup.revert') !== 'toolGroup.revert' ? _t('toolGroup.revert') : '↩ Revert changes')}
              </button>
            )}
            {effectiveReverted && (
              <span className={`${styles.revertBtn} ${styles.revertBtnDone}`}>
                {_t('toolGroup.reverted') !== 'toolGroup.reverted' ? _t('toolGroup.reverted') : '✓ Reverted'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({ tool, agentName, suppressInlineDiff }: {
  tool: ToolCall;
  agentName?: string;
  suppressInlineDiff?: boolean;
}) {
  const detail = extractToolDetail(tool.name, tool.args);
  const detailFull = extractToolDetailFull(tool.name, tool.args);
  const diffText = toolDiffString(tool);
  const hasDiff = diffText != null;
  const expandable = Boolean(detailFull) || (hasDiff && !suppressInlineDiff);
  const label = getToolLabel(tool.name, tool.done ? 'done' : 'running', agentName);

  const tag = tool.args?.agentId as string | undefined;

  const statusEl = tool.done ? (
    <span className={`${styles.toolStatus} ${tool.success ? styles.toolStatusDone : styles.toolStatusFailed}`}>
      {tool.success ? '✓' : '✗'}
    </span>
  ) : (
    <span className={styles.toolDots}><span /><span /><span /></span>
  );

  const expandHint = window.t?.('toolGroup.expandDetail');
  const detailTitle =
    expandHint && expandHint !== 'toolGroup.expandDetail' ? expandHint : '';

  const filePath = (tool.args?.file_path || tool.args?.path || '') as string;

  const rowInner = (
    <>
      <span className={styles.toolDesc}>{label}</span>
      {expandable && <span className={styles.toolExpandChevron} aria-hidden>▸</span>}
      {detail && <span className={styles.toolDetail}>{detail}</span>}
      {tag && <span className={styles.toolTag}>{tag}</span>}
      {statusEl}
    </>
  );

  return (
    <div className={styles.toolIndicator} data-tool={tool.name} data-done={String(tool.done)} style={hasDiff ? { maxWidth: '100%' } : undefined}>
      {expandable ? (
        <details className={styles.toolIndicatorExpand} title={detailTitle || undefined}>
          <summary className={styles.toolIndicatorSummary}>{rowInner}</summary>
          {hasDiff && diffText ? (
            <DiffView diff={diffText} filePath={filePath} />
          ) : (
            <pre className={styles.toolDetailFull}>{detailFull}</pre>
          )}
        </details>
      ) : (
        rowInner
      )}
    </div>
  );
});
