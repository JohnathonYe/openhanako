import { useLayoutEffect, useRef, useState } from 'react';
import type { TodoItem } from '../../types';
import type { PlanFlowPhase } from '../../stores/session-slice';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

function tSafe(
  tr: (k: string, v?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) {
  const v = vars ? tr(key, vars) : tr(key);
  if (v !== key) return v;
  if (!vars) return fallback;
  let out = fallback;
  for (const [k, val] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(val));
  }
  return out;
}

type EditRow = { text: string; done: boolean; id?: number };

export function TodoDisplay({
  todos,
  planFlowPhase,
  onCancelPlan,
  onConfirmPlan,
  onClearTodos,
}: {
  todos: TodoItem[];
  planFlowPhase: PlanFlowPhase;
  onCancelPlan: () => void;
  onConfirmPlan: (items: { text: string }[]) => void | Promise<void>;
  onClearTodos?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<EditRow[]>([]);
  const prevPhase = useRef<PlanFlowPhase>('idle');

  const awaiting = planFlowPhase === 'awaiting_confirm';
  const draftSent = planFlowPhase === 'draft_sent';

  // 仅在进入 awaiting_confirm 时从 store 拉取草稿；勿依赖 todos，否则 sessionTodos 引用变化会反复跑 effect 覆盖用户追加/编辑
  useLayoutEffect(() => {
    if (planFlowPhase === 'awaiting_confirm' && prevPhase.current !== 'awaiting_confirm') {
      const latest = useStore.getState().sessionTodos;
      const list = Array.isArray(latest) ? latest : [];
      setEditDraft(
        list.map((td: TodoItem, i: number) => ({
          text: td.text,
          done: td.done,
          id: td.id ?? i + 1,
        })),
      );
      setOpen(false);
    }
    prevPhase.current = planFlowPhase;
  }, [planFlowPhase]);

  useLayoutEffect(() => {
    if (!awaiting) return;
    const list = Array.isArray(todos) ? todos : [];
    if (list.length === 0) return;
    setEditDraft(prev => {
      const knownIds = new Set(prev.map(row => row.id).filter((id): id is number => typeof id === 'number'));
      const appended = list
        .filter(td => typeof td.id === 'number' && !knownIds.has(td.id))
        .map((td, i) => ({
          text: td.text,
          done: td.done,
          id: td.id ?? prev.length + i + 1,
        }));
      return appended.length > 0 ? [...prev, ...appended] : prev;
    });
  }, [awaiting, todos]);

  const displayTodos = awaiting ? editDraft : todos;
  if (draftSent) return null;
  if (!displayTodos || displayTodos.length === 0) return null;

  const done = displayTodos.filter(td => td.done).length;

  const updateRow = (i: number, text: string) => {
    setEditDraft(prev => {
      const next = [...prev];
      next[i] = { ...next[i], text };
      return next;
    });
  };

  const removeRow = (i: number) => {
    setEditDraft(prev => {
      const next = prev.filter((_, j) => j !== i);
      return next.length === 0 ? [{ text: '', done: false }] : next;
    });
  };

  const addRow = () => {
    setOpen(true);
    setEditDraft(prev => [...prev, { text: '', done: false }]);
  };

  if (awaiting) {
    return (
      <div className={styles['input-top-bar']}>
        <div className={`${styles['plan-confirm-panel']}${open ? ` ${styles['plan-confirm-panel-expanded']}` : ''}`}>
          <div className={styles['plan-confirm-header']}>
            <span className={styles['todo-trigger-icon']}>☑</span>
            <span className={styles['plan-confirm-title']}>{tSafe(t, 'plan.panelTitle', '计划确认')}</span>
            <span className={styles['todo-trigger-count']}>{done}/{displayTodos.length}</span>
            <div className={styles['plan-confirm-header-actions']}>
              <button type="button" className={styles['plan-confirm-btn']} onClick={() => onConfirmPlan(editDraft.map(r => ({ text: r.text })))}>
                {tSafe(t, 'plan.confirmExecute', '确认执行')}
              </button>
              <button
                type="button"
                className={styles['plan-confirm-toggle']}
                onClick={() => setOpen(!open)}
                aria-expanded={open}
              >
                {open ? tSafe(t, 'plan.collapse', '收起') : tSafe(t, 'plan.expandPanel', '展开')}
              </button>
            </div>
          </div>
          {open && (
            <div className={styles['plan-confirm-body']}>
              <p className={styles['plan-confirm-hint']}>
                {tSafe(t, 'plan.confirmHint', '可编辑未完成项或追加步骤，确认后助手将按序执行，并在每步完成后用 todo 工具标记完成。')}
              </p>
              {displayTodos.map((td, i) => (
                <div key={td.id ?? `r-${i}`} className={`${styles['todo-item']}${td.done ? ` ${styles.done}` : ''}`}>
                  <div className={styles['todo-plan-edit-row']}>
                    <span className={styles['todo-check']}>{td.done ? '✓' : '○'}</span>
                    <input
                      type="text"
                      className={styles['todo-plan-input']}
                      value={td.text}
                      onChange={e => updateRow(i, e.target.value)}
                      placeholder={tSafe(t, 'plan.stepPlaceholder', '步骤说明')}
                    />
                    {!td.done && (
                      <button type="button" className={styles['todo-plan-remove']} onClick={() => removeRow(i)} aria-label="remove">
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button type="button" className={styles['todo-plan-add']} onClick={addRow}>
                {tSafe(t, 'plan.addStep', '+ 添加步骤')}
              </button>
              <div className={styles['plan-confirm-actions']}>
                <button type="button" className={styles['plan-confirm-btn']} onClick={() => onConfirmPlan(editDraft.map(r => ({ text: r.text })))}>
                  {tSafe(t, 'plan.confirmExecute', '确认执行')}
                </button>
                <button type="button" className={styles['plan-cancel-btn']} onClick={onCancelPlan}>
                  {tSafe(t, 'plan.cancelPlan', '取消')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const canClear = displayTodos.length > 0 && !!onClearTodos;
  return (
    <div className={styles['input-top-bar']}>
      <div className={`${styles['todo-display']} ${styles['has-todos']}${open ? ` ${styles.open}` : ''}`}>
        <button type="button" className={styles['todo-trigger']} onClick={() => setOpen(!open)}>
          <span className={styles['todo-trigger-icon']}>☑</span>
          <span className={styles['todo-trigger-label']}>To Do</span>
          <span className={styles['todo-trigger-count']}>{done}/{displayTodos.length}</span>
        </button>
        {canClear && onClearTodos && (
          <button
            type="button"
            className={styles['todo-clear-btn']}
            onClick={onClearTodos}
            title={tSafe(t, 'plan.clearTodos', '清空待办')}
            aria-label={tSafe(t, 'plan.clearTodos', '清空待办')}
          >
            {tSafe(t, 'plan.clearTodos', '清空')}
          </button>
        )}
        {open && (
          <div className={styles['todo-list']}>
            {displayTodos.map((td, i) => (
              <div key={td.id ?? `r-${i}`} className={`${styles['todo-item']}${td.done ? ` ${styles.done}` : ''}`}>
                <span className={styles['todo-check']}>{td.done ? '✓' : '○'}</span> {td.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
