/**
 * 纯工具函数，从 modules/utils.js 平移为 TS module
 */

export function toSlash(s: string): string { return s.replace(/\\/g, '/'); }
export function baseName(s: string): string { return s.replace(/\\/g, '/').split('/').pop() || s; }

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

/** 与后端 chat 路由一致的可上传视频扩展名 */
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
/** 语音/音频（.webm 作视频处理） */
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);

/** 与项目根 `lib/media-limits.js` 保持一致 */
export const MAX_MEDIA_ATTACHMENTS = 5;
/** 发送给模型的单张图片原始大小上限（字节） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单个视频原始大小上限（字节）；上传 / IPC read-base64 / WS 均同限 */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
/** 单条语音/音频上限（与 lib/media-limits.js 一致） */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** 与 `lib/media-limits.js` 中 MAX_WS_MESSAGE_BYTES 一致（prompt 整包 JSON 长度上限） */
export const MAX_WS_MESSAGE_BYTES = 200 * 1024 * 1024;
/** 除图片/视频/语音外的附件数量上限（路径引用等） */
export const MAX_NON_MEDIA_ATTACHMENTS = 9;

export function isImageFile(name: string): boolean {
  const ext = (name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return IMAGE_EXTS.has(ext);
}

export function isVideoFile(name: string): boolean {
  const ext = (name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return VIDEO_EXTS.has(ext);
}

export function isAudioFile(name: string): boolean {
  const ext = (name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return AUDIO_EXTS.has(ext);
}

export function isMediaAttachment(file: { name: string; isDirectory?: boolean }): boolean {
  return !file.isDirectory && (isImageFile(file.name) || isVideoFile(file.name) || isAudioFile(file.name));
}

export function countMediaAttachments(files: Array<{ name: string; isDirectory?: boolean }>): number {
  return files.filter(isMediaAttachment).length;
}

/** 根据文件名推断发送给模型的 MIME（图片/视频/音频） */
export function guessMediaMimeType(name: string): string | null {
  const ext = (name || '').toLowerCase().replace(/^.*\./, '');
  const imageMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  };
  const videoMap: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  const audioMap: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  };
  return imageMap[ext] || videoMap[ext] || audioMap[ext] || null;
}

export function formatSessionDate(isoStr: string): string {
  const t = window.t ?? ((p: string) => p);
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow');
  if (diffMin < 60) return t('time.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('time.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('time.daysAgo', { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t('time.dateFormat', { m, d });
}

export function cronToHuman(schedule: number | string): string {
  const t = window.t ?? ((p: string) => p);
  if (typeof schedule === 'number') {
    const h = Math.round(schedule / 3600000);
    return h > 0 ? t('cron.everyHours', { n: h }) : t('cron.everyMinutes', { n: Math.round(schedule / 60000) });
  }
  const s = String(schedule);
  const parts = s.split(' ');
  if (parts.length !== 5) return s;
  const [min, hour, , , dow] = parts;
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: min.slice(2) });
  }
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    return t('cron.everyHours', { n: hour.slice(2) });
  }
  if (min === '0' && hour === '*' && dow === '*') return t('cron.hourly');
  if (hour === '*' && dow === '*' && /^\d+$/.test(min)) return t('cron.hourly');
  if (dow === '*' && hour !== '*' && min !== '*') {
    return t('cron.dailyAt', { hour, min: min.padStart(2, '0') });
  }
  const dayNames: string[] = (window.t as (...args: unknown[]) => unknown)('cron.dayNames') as string[] || ['日', '一', '二', '三', '四', '五', '六'];
  const weekPrefix = t('cron.weekPrefix');
  if (dow !== '*' && hour !== '*') {
    const dayStr = dow.split(',').map(d => `${weekPrefix}${(Array.isArray(dayNames) ? dayNames : [])[+d] || d}`).join('/');
    return t('cron.weeklyAt', { days: dayStr, hour, min: min.padStart(2, '0') });
  }
  return s;
}

/** 日常巡检间隔（分钟）→ 展示文案，≥60 分时用「小时」 */
export function formatPatrolIntervalMinutes(
  totalMinutes: number,
  tr: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const n = Math.max(1, Math.round(totalMinutes));
  if (n < 60) return tr('activity.intervalMinutesFmt', { n });
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (m === 0) return tr('activity.intervalHoursFmt', { n: h });
  return tr('activity.intervalHoursMinutesFmt', { hours: h, minutes: m });
}

/** 立即巡检冷却剩余（毫秒） */
export function formatPatrolCooldownMs(
  ms: number,
  tr: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return tr('activity.cooldownHmsFmt', { hours: h, minutes: m });
  if (m > 0) return tr('activity.cooldownMmsFmt', { minutes: m, seconds: s });
  return tr('activity.cooldownSecondsFmt', { seconds: s });
}

/**
 * 从 assistant 回复中解析 mood 区块
 */
export function parseMoodFromContent(content: string): { mood: string | null; text: string } {
  if (!content) return { mood: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|moods|pulse|reflect|reflection)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, text: content };
  const raw = match[2].trim()
    .replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '').replace(/\n+$/, '');
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood: raw, text };
}

/**
 * 给 md-content 里的代码块注入复制按钮
 */
export function injectCopyButtons(container: HTMLElement): void {
  const t = window.t ?? ((p: string) => p);
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = t('attach.copy');
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text || '').then(() => {
        btn.textContent = t('attach.copied');
        setTimeout(() => { btn.textContent = t('attach.copy'); }, 1500);
      });
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}
