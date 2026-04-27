/**
 * 解析 Pi SDK generateDiffString 风格的统一 diff 文本（与 DiffView 一致）。
 */

export type DiffLineType = 'add' | 'remove' | 'context' | 'skip';

export interface DiffLineParsed {
  type: DiffLineType;
  lineNum: string;
  content: string;
}

export function parseDiffLines(raw: string): DiffLineParsed[] {
  if (!raw) return [];
  return raw.split('\n').map(line => {
    if (line.startsWith('+')) {
      const rest = line.slice(1);
      const m = rest.match(/^(\s*\d+)\s(.*)$/);
      return { type: 'add', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
    }
    if (line.startsWith('-')) {
      const rest = line.slice(1);
      const m = rest.match(/^(\s*\d+)\s(.*)$/);
      return { type: 'remove', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
    }
    if (line.trimEnd().endsWith('...')) {
      return { type: 'skip', lineNum: '', content: '···' };
    }
    const rest = line.slice(1);
    const m = rest.match(/^(\s*\d+)\s(.*)$/);
    return { type: 'context', lineNum: m?.[1]?.trim() ?? '', content: m?.[2] ?? rest };
  });
}

export function countDiffLineStats(raw: string): { add: number; remove: number } {
  const lines = parseDiffLines(raw);
  return {
    add: lines.filter(l => l.type === 'add').length,
    remove: lines.filter(l => l.type === 'remove').length,
  };
}
