import type { DragEvent } from 'react';

/**
 * 从拖放事件收集本地绝对路径（Electron：含文件夹）。
 * 先读 dataTransfer.files，为空时再读 items + getAsFile（macOS 拖文件夹时常需要后者）。
 */
export function collectDropPaths(e: DragEvent): string[] {
  const platform = window.platform;
  const tryPath = (f: File | null): string | null => {
    if (!f) return null;
    try {
      const p = platform?.getFilePath?.(f) ?? (f as unknown as { path?: string }).path;
      return p && typeof p === 'string' && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  };

  const out: string[] = [];
  const dt = e.dataTransfer;
  if (!dt) return out;

  if (dt.files?.length) {
    for (let i = 0; i < dt.files.length; i++) {
      const p = tryPath(dt.files[i]);
      if (p) out.push(p);
    }
  }
  if (out.length === 0 && dt.items?.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      const p = tryPath(f);
      if (p) out.push(p);
    }
  }
  return [...new Set(out)];
}
