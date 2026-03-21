import React, { useEffect, useRef } from 'react';
import { useSettingsStore, type Agent } from '../../store';
import { hanaFetch, hanaUrl, yuanFallbackAvatar } from '../../api';
import { t } from '../../helpers';
import { loadAgents } from '../../actions';
import styles from '../../Settings.module.css';

export function AgentCardStack({ agents, selectedId, currentAgentId, onSelect, onAvatarClick, children }: {
  agents: Agent[];
  selectedId: string | null;
  currentAgentId: string | null;
  onSelect: (id: string) => void;
  onAvatarClick: () => void;
  children?: React.ReactNode;
}) {
  const cardsRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const n = agents.length;
  const stepTight = n > 1 ? Math.min(4, 16 / (n - 1)) : 0;
  const spreadStep = 62;
  const spreadOffset = -(n - 1) * spreadStep / 2;
  const spreadWidth = Math.max(240, (n - 1) * spreadStep + 72);
  const ts = Date.now();

  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;

    const handlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];

    const cards = [...container.children] as HTMLElement[];
    cards.forEach((card, dragIdx) => {
      const handler = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!container.matches(':hover')) return;

        e.preventDefault();
        card.setPointerCapture(e.pointerId);

        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let dropIdx = dragIdx;

        const allCards = [...container.children] as HTMLElement[];
        const positions = allCards.map(c => parseFloat(c.style.getPropertyValue('--tx-spread')) || 0);
        const origTx = positions[dragIdx];

        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

          if (!moved) {
            moved = true;
            card.classList.add(styles['dragging']);
            card.dataset.wasDragged = '1';
          }

          card.style.transform = `rotate(0deg) translateX(${origTx + dx}px) translateY(-4px)`;

          const currentPos = origTx + dx;
          let newIdx = dragIdx;
          for (let j = 0; j < positions.length; j++) {
            if (j === dragIdx) continue;
            if (dragIdx < j && currentPos > positions[j] - 15) newIdx = j;
            if (dragIdx > j && currentPos < positions[j] + 15) newIdx = Math.min(newIdx, j);
          }

          allCards.forEach((c, ci) => {
            if (c === card) return;
            if (ci >= Math.min(dragIdx, newIdx) && ci <= Math.max(dragIdx, newIdx) && newIdx !== dragIdx) {
              const shift = dragIdx < newIdx ? -spreadStep : spreadStep;
              c.style.transform = `rotate(0deg) translateX(${positions[ci] + shift}px)`;
            } else {
              c.style.transform = `rotate(0deg) translateX(${positions[ci]}px)`;
            }
            c.style.transition = 'transform 0.2s var(--ease-out)';
          });

          dropIdx = newIdx;
        };

        const onUp = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.classList.remove(styles['dragging']);

          allCards.forEach(c => { c.style.transform = ''; c.style.transition = ''; });

          if (!moved) return;

          if (dropIdx !== dragIdx) {
            const currentAgents = agentsRef.current;
            const reordered = [...currentAgents];
            const [movedAgent] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, movedAgent);
            useSettingsStore.setState({ agents: reordered });
            hanaFetch('/api/agents/order', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered.map(a => a.id) }),
            }).catch(err => {
              console.error('[agent-reorder] failed:', err);
              loadAgents();
            });
          }
        };

        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
      };

      card.addEventListener('pointerdown', handler);
      handlers.push([card, handler]);
    });

    return () => {
      handlers.forEach(([el, fn]) => el.removeEventListener('pointerdown', fn));
    };
  }, [agents, spreadStep]);

  return (
    <div
      className={styles['agent-card-stack']}
      style={{ '--cards-spread-width': spreadWidth } as React.CSSProperties}
    >
      <div className={styles['agent-cards']} ref={cardsRef}>
        {agents.map((agent, i) => {
          const rotTight = i * stepTight;
          const txSpread = spreadOffset + i * spreadStep;
          const z = n - i;
          const isSelected = agent.id === selectedId;

          return (
            <div
              key={agent.id}
              className={`${styles['agent-card']}${isSelected  ? ' ' + styles['selected'] : ''}`}
              data-agent-id={agent.id}
              data-index={i}
              style={{
                '--rot-tight': `${rotTight}deg`,
                '--tx-spread': `${txSpread}px`,
                '--z': z,
                zIndex: z,
              } as React.CSSProperties}
              onClick={(e) => {
                const el = e.currentTarget as HTMLElement;
                if (el.dataset.wasDragged) { delete el.dataset.wasDragged; return; }
                if (isSelected) onAvatarClick();
                else onSelect(agent.id);
              }}
            >
              <div className={styles['agent-card-inner']}>
                <img
                  className={styles['agent-card-avatar']}
                  draggable={false}
                  src={hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`)}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan);
                  }}
                />
                {isSelected && (
                  <div className={styles['agent-card-overlay']}>
                    <span>{t('settings.agent.changeAvatar')}</span>
                  </div>
                )}
              </div>
              {agent.id === currentAgentId && <div className={styles['agent-card-badge']} />}
              <span className={styles['agent-card-name']}>{agent.name}</span>
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
