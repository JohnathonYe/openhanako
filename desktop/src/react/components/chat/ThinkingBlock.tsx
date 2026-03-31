/**
 * ThinkingBlock — 可折叠的思考过程区块
 *
 * 使用 div 而非 <details>，避免原生 toggle 行为与 React 受控状态冲突。
 */

import { memo, useState, useCallback } from 'react';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const t = window.t ?? ((p: string) => p);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <div className={styles.thinkingBlock}>
      <div className={styles.thinkingBlockSummary} onClick={toggle}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        {' '}{sealed ? t('thinking.done') : (
          <>{t('thinking.active')}<span className={styles.thinkingDots}><span /><span /><span /></span></>
        )}
      </div>
      {open && content && (
        <div className={styles.thinkingBlockBody}>{content}</div>
      )}
    </div>
  );
});
