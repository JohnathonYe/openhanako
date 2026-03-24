/**
 * DeskRulesSection — 必读规则区（.rules/*.md 管理）
 *
 * 可折叠列表，支持新增、编辑、删除。
 * 编辑/新建时，通过 portal 将编辑器浮动到 .main-content 上方，
 * 提供更大的编辑区域（类似 FloatingPanels 体验）。
 * LLM 在每次工作前会读取 .rules/ 下所有 .md 文件。
 */

import { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { createDeskRule, updateDeskRule, removeDeskRule } from '../../stores/desk-actions';
import type { DeskRuleInfo } from '../../stores/desk-slice';
import { ArtifactEditor } from '../ArtifactEditor';
import type { ArtifactEditorHandle } from '../ArtifactEditor';
import s from './Desk.module.css';

const DESK_RULES_KEY = 'hana-desk-rules-collapsed';

function useMainContentEl() {
  const [el, setEl] = useState<Element | null>(null);
  useEffect(() => {
    setEl(document.querySelector('.main-content'));
  }, []);
  return el;
}

/* ── 浮动编辑面板 ── */

interface RuleEditorPanelProps {
  title: string;
  nameInput?: { value: string; onChange: (v: string) => void; placeholder: string };
  editorRef: React.RefObject<ArtifactEditorHandle | null>;
  content: string;
  onContentChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  container: Element;
}

function RuleEditorPanel({ title, nameInput, editorRef, content, onContentChange, onSave, onCancel, container }: RuleEditorPanelProps) {
  const t = window.t ?? ((p: string) => p);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave, onCancel]);

  return createPortal(
    <div className={s.ruleEditorOverlay}>
      <div className={s.ruleEditorPanel}>
        <div className={s.ruleEditorPanelHeader}>
          {nameInput ? (
            <input
              className={s.ruleEditorPanelNameInput}
              placeholder={nameInput.placeholder}
              value={nameInput.value}
              onChange={e => nameInput.onChange(e.target.value)}
              autoFocus
            />
          ) : (
            <h2 className={s.ruleEditorPanelTitle}>{title}</h2>
          )}
          <button className={s.ruleBtnMuted} onClick={onCancel}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={s.ruleEditorPanelBody}>
          <ArtifactEditor
            ref={editorRef}
            content={content}
            mode="markdown"
            onChange={onContentChange}
          />
        </div>
        <div className={s.ruleEditorPanelFooter}>
          <button className={s.ruleBtnMuted} onClick={onCancel}>
            {t('desk.rulesCancel')}
          </button>
          <button className={s.ruleBtn} onClick={onSave}>
            {t('desk.rulesSave')}
          </button>
        </div>
      </div>
    </div>,
    container,
  );
}

/* ── 主组件 ── */

export function DeskRulesSection() {
  const rules = useStore(s => s.deskRules);
  const basePath = useStore(s => s.deskBasePath);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_RULES_KEY) === '1',
  );
  const [editing, setEditing] = useState<DeskRuleInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const editEditorRef = useRef<ArtifactEditorHandle | null>(null);
  const createEditorRef = useRef<ArtifactEditorHandle | null>(null);
  const mainContentEl = useMainContentEl();

  const t = window.t ?? ((p: string) => p);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_RULES_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const content = createEditorRef.current?.getValue() ?? newContent;
    const ok = await createDeskRule(newName.trim(), content);
    if (ok) {
      setCreating(false);
      setNewName('');
      setNewContent('');
    }
  }, [newName, newContent]);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    const content = editEditorRef.current?.getValue() ?? editing.content;
    await updateDeskRule(editing.name, content);
    setEditing(null);
  }, [editing]);

  const cancelEdit = useCallback(() => setEditing(null), []);
  const cancelCreate = useCallback(() => {
    setCreating(false);
    setNewName('');
    setNewContent('');
  }, []);

  const handleDelete = useCallback(async (name: string) => {
    await removeDeskRule(name);
    if (editing?.name === name) setEditing(null);
  }, [editing]);

  if (!basePath) return null;

  return (
    <div className={s.skillsSection}>
      <button className={s.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.rules')}</span>
        <span className={s.skillsCount}>{rules.length}</span>
        <svg
          className={`${s.skillsChevron}${collapsed ? '' : ` ${s.skillsChevronOpen}`}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {!collapsed && (
        <div className={s.rulesList}>
          {rules.map(rule => (
            <div key={rule.name} className={s.ruleItem}>
              <div className={s.ruleRow}>
                <span className={s.ruleName} title={rule.name}>{rule.name}</span>
                {editing?.name === rule.name && (
                  <span className={s.ruleEditingHint}>{t('desk.rulesEditing') || '编辑中…'}</span>
                )}
                <button
                  className={s.ruleIconBtn}
                  title={t('desk.rulesEdit')}
                  onClick={() => setEditing({ ...rule })}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  className={`${s.ruleIconBtn} ${s.ruleIconDanger}`}
                  title={t('desk.rulesDelete')}
                  onClick={() => handleDelete(rule.name)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}

          {creating ? (
            <span className={s.ruleEditingHint}>{t('desk.rulesCreating') || '新建中…'}</span>
          ) : (
            <button
              className={s.ruleAddBtn}
              onClick={() => setCreating(true)}
            >
              + {t('desk.rulesAdd')}
            </button>
          )}
        </div>
      )}

      {/* 浮动编辑面板 — portal 到 .main-content */}
      {editing && mainContentEl && (
        <RuleEditorPanel
          title={editing.name}
          editorRef={editEditorRef}
          content={editing.content}
          onContentChange={text => setEditing(prev => prev ? { ...prev, content: text } : null)}
          onSave={handleSave}
          onCancel={cancelEdit}
          container={mainContentEl}
        />
      )}
      {creating && mainContentEl && (
        <RuleEditorPanel
          title=""
          nameInput={{ value: newName, onChange: setNewName, placeholder: t('desk.rulesNamePlaceholder') }}
          editorRef={createEditorRef}
          content={newContent}
          onContentChange={setNewContent}
          onSave={handleCreate}
          onCancel={cancelCreate}
          container={mainContentEl}
        />
      )}
    </div>
  );
}
