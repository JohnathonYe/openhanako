/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useState, useCallback } from 'react';
import styles from './Chat.module.css';
import { extractToolDetail, extractToolDetailFull } from '../../utils/message-parser';
import { useStore } from '../../stores';
import type { ToolCall } from '../../stores/chat-types';

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

function getToolLabel(name: string, phase: string, agentNameOverride?: string): string {
  const t = window.t;
  const agentName = agentNameOverride || useStore.getState().agentName || 'Hanako';
  const vars = { name: agentName };
  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;
  return t?.(`tool._fallback.${phase}`, vars) || name;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, collapsed: initialCollapsed, agentName }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  const allDone = tools.every(t => t.done);
  const failCount = tools.filter(t => t.done && !t.success).length;
  const isSingle = tools.length === 1;

  // 摘要标题
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
          <ToolIndicator key={`${tool.name}-${i}`} tool={tool} agentName={agentName} />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({ tool, agentName }: { tool: ToolCall; agentName?: string }) {
  const detail = extractToolDetail(tool.name, tool.args);
  const detailFull = extractToolDetailFull(tool.name, tool.args);
  /** 有参数可展示时均可点击展开查看完整调用细节（不限于预览被截断的情况） */
  const expandable = Boolean(detailFull);
  const label = getToolLabel(tool.name, tool.done ? 'done' : 'running', agentName);

  // 如果 args 里有 tag 类型信息（如 agent 名）
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
    <div className={styles.toolIndicator} data-tool={tool.name} data-done={String(tool.done)}>
      {expandable ? (
        <details className={styles.toolIndicatorExpand} title={detailTitle || undefined}>
          <summary className={styles.toolIndicatorSummary}>{rowInner}</summary>
          <pre className={styles.toolDetailFull}>{detailFull}</pre>
        </details>
      ) : (
        rowInner
      )}
    </div>
  );
});
