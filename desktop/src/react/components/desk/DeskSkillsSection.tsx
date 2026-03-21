/**
 * DeskSkillsSection — 技能快捷区（可折叠列表 + toggle 开关）
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Desk.module.css';

const DESK_SKILLS_KEY = 'hana-desk-skills-collapsed';

export function DeskSkillsSection() {
  const skills = useStore(s => s.deskSkills);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkillsFn = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/skills');
      const data = await res.json();
      const all = (data.skills || []) as Array<{
        name: string; enabled: boolean; hidden?: boolean;
        source?: string; externalLabel?: string | null;
      }>;
      useStore.getState().setDeskSkills(
        all.filter(s => !s.hidden).map(s => ({
          name: s.name,
          enabled: s.enabled,
          source: s.source,
          externalLabel: s.externalLabel,
        })),
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadDeskSkillsFn();
    window.__loadDeskSkills = loadDeskSkillsFn;
    return () => { delete window.__loadDeskSkills; };
  }, [loadDeskSkillsFn]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const prev = useStore.getState().deskSkills;
    useStore.getState().setDeskSkills(
      prev.map(s => s.name === name ? { ...s, enabled: enable } : s),
    );
    const enabledList = prev.map(s => s.name === name ? { ...s, enabled: enable } : s)
      .filter(s => s.enabled).map(s => s.name);
    try {
      const agentId = useStore.getState().currentAgentId || '';
      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      useStore.getState().setDeskSkills(prev);
    }
  }, []);

  const enabledCount = skills.filter(s => s.enabled).length;
  const t = window.t ?? ((p: string) => p);

  if (skills.length === 0) return null;

  return (
    <div className={s.skillsSection}>
      <button className={s.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.skills')}</span>
        <span className={s.skillsCount}>{enabledCount}</span>
        <svg
          className={`${s.skillsChevron}${collapsed ? '' : ` ${s.skillsChevronOpen}`}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className={s.skillsList}>
          {skills.map(sk => (
            <div className={s.skillItem} key={sk.name}>
              <span className={s.skillName}>{sk.name}</span>
              {sk.externalLabel && (
                <span className={s.skillSource}>{sk.externalLabel}</span>
              )}
              <button
                className={`hana-toggle mini${sk.enabled ? ' on' : ''}`}
                onClick={() => toggleSkill(sk.name, !sk.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
