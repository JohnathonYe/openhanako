/**
 * DiffView — renders a unified diff string from the edit/write tool's details.diff
 *
 * The diff format from Pi SDK's generateDiffString:
 *   " <lineNum> <context>"    — context line
 *   "+<lineNum> <added>"      — added line
 *   "-<lineNum> <removed>"    — removed line
 *   " <spaces> ..."           — skipped region
 */

import { memo, useState, useCallback } from 'react';
import styles from './Chat.module.css';

interface DiffViewProps {
  /** 统一 diff 文本；非字符串时组件不渲染，避免历史数据异常导致崩溃 */
  diff: unknown;
  filePath?: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'skip';
  lineNum: string;
  content: string;
}

function parseDiffLines(raw: string): DiffLine[] {
  if (!raw) return [];
  return raw.split('\n').map(line => {
    if (line.startsWith('+')) {
      const rest = line.slice(1);
      const m = rest.match(/^(\s*\d+)\s(.*)$/);
      return { type: 'add', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
    }
    if (line.startsWith('-')) {
      const rest = line.slice(1);
      const m = rest.match(/^(\s*\d+)\s(.*)$/);
      return { type: 'remove', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
    }
    if (line.trimEnd().endsWith('...')) {
      return { type: 'skip', lineNum: '', content: '···' };
    }
    const rest = line.slice(1);
    const m = rest.match(/^(\s*\d+)\s(.*)$/);
    return { type: 'context', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
  });
}

function asDiffString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

export const DiffView = memo(function DiffView({ diff, filePath }: DiffViewProps) {
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded(v => !v), []);
  const diffText = asDiffString(diff);
  const lines = parseDiffLines(diffText);
  if (lines.length === 0) return null;

  const addCount = lines.filter(l => l.type === 'add').length;
  const removeCount = lines.filter(l => l.type === 'remove').length;

  return (
    <div className={styles.diffView}>
      <div className={styles.diffHeader} onClick={toggle}>
        <span className={styles.diffToggle}>{expanded ? '▾' : '▸'}</span>
        {filePath && <span className={styles.diffFilePath}>{filePath}</span>}
        <span className={styles.diffStats}>
          {addCount > 0 && <span className={styles.diffStatsAdd}>+{addCount}</span>}
          {removeCount > 0 && <span className={styles.diffStatsRemove}>-{removeCount}</span>}
        </span>
      </div>
      {expanded && (
        <div className={styles.diffBody}>
          {lines.map((line, i) => (
            <div
              key={i}
              className={`${styles.diffLine} ${
                line.type === 'add' ? styles.diffLineAdd :
                line.type === 'remove' ? styles.diffLineRemove :
                line.type === 'skip' ? styles.diffLineSkip :
                ''
              }`}
            >
              <span className={styles.diffLineNum}>{line.lineNum}</span>
              <span className={styles.diffLinePrefix}>
                {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
              </span>
              <span className={styles.diffLineContent}>{line.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
