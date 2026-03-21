import { useState } from 'react';
import styles from './InputArea.module.css';

export function TodoDisplay({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter(td => td.done).length;

  return (
    <div className={styles['input-top-bar']}>
      <div className={`${styles['todo-display']} ${styles['has-todos']}${open ? ` ${styles.open}` : ''}`}>
        <button className={styles['todo-trigger']} onClick={() => setOpen(!open)}>
          <span className={styles['todo-trigger-icon']}>☑</span>
          <span className={styles['todo-trigger-label']}>To Do</span>
          <span className={styles['todo-trigger-count']}>{done}/{todos.length}</span>
        </button>
        {open && (
          <div className={styles['todo-list']}>
            {todos.map((td, i) => (
              <div key={i} className={`${styles['todo-item']}${td.done ? ` ${styles.done}` : ''}`}>
                <span className={styles['todo-check']}>{td.done ? '✓' : '○'}</span> {td.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
