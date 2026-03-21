/**
 * JianEditor — jian.md 编辑器面板
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { saveJianContent } from '../../stores/desk-actions';
import s from './Desk.module.css';

export function JianEditor() {
  const deskJianContent = useStore(s => s.deskJianContent);
  const [localValue, setLocalValue] = useState(deskJianContent || '');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const prevContentRef = useRef(deskJianContent);

  useEffect(() => {
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(deskJianContent || '');
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setLocalValue(value);

    useStore.setState({ deskJianContent: value });
    prevContentRef.current = value;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveJianContent(value);
    }, 800);
  }, []);

  return (
    <div className={s.editor} data-desk-editor="">
      <div className={s.editorHeader}>
        <span className={s.editorLabel}>{(window.t ?? ((p: string) => p))('desk.jianLabel')}</span>
      </div>
      <span className={s.editorStatus} ref={statusRef}></span>
      <textarea
        className={s.editorInput}
        placeholder={(window.t ?? ((p: string) => p))('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
    </div>
  );
}
