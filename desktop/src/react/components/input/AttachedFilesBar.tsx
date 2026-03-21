import { SVG_ICONS } from '../../utils/icons';
import styles from './InputArea.module.css';

export function AttachedFilesBar({ files, onRemove }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean }>;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={styles['attached-files']}>
      {files.map((f, i) => (
        <span key={f.path} className={styles['file-tag']}>
          <span className={styles['file-tag-name']}>
            <span
              className={styles['file-tag-icon']}
              dangerouslySetInnerHTML={{ __html: f.isDirectory ? SVG_ICONS?.folder : SVG_ICONS?.clip }}
            />
            {f.name}
          </span>
          <button className={styles['file-tag-remove']} onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
    </div>
  );
}
