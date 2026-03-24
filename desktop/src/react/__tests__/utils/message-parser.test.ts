import { describe, it, expect } from 'vitest';
import {
  parseMoodFromContent,
  parseXingFromContent,
  parseUserAttachments,
  stripPlanDraftWrapper,
  cleanMoodText,
  truncatePath,
  extractHostname,
  truncateHead,
  extractToolDetail,
  extractToolDetailFull,
  moodLabel,
  extractTodosFromAddText,
  extractPlanStepsFromAssistantBlocks,
  mergePlanDraftTodosFromBlocks,
  expandTodosNumberedLines,
} from '../../utils/message-parser';

describe('parseMoodFromContent', () => {
  it('无 mood 标签返回原文', () => {
    const result = parseMoodFromContent('hello world');
    expect(result.mood).toBeNull();
    expect(result.yuan).toBeNull();
    expect(result.text).toBe('hello world');
  });

  it('空内容返回空', () => {
    const result = parseMoodFromContent('');
    expect(result.mood).toBeNull();
    expect(result.text).toBe('');
  });

  it('解析 <mood> 标签', () => {
    const input = '<mood>feeling good</mood>\n\nSome text here.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('feeling good');
    expect(result.yuan).toBe('hanako');
    expect(result.text).toBe('Some text here.');
  });

  it('解析 <pulse> 标签映射到 butter', () => {
    const input = '<pulse>energetic</pulse>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('energetic');
    expect(result.yuan).toBe('butter');
  });

  it('解析 <reflect> 标签映射到 ming', () => {
    const input = '<reflect>pondering</reflect>\nContent.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('pondering');
    expect(result.yuan).toBe('ming');
  });

  it('mood 内容去除代码块包裹', () => {
    const input = '<mood>```\nline1\nline2\n```</mood>\nText.';
    const result = parseMoodFromContent(input);
    expect(result.mood).toBe('line1\nline2');
  });
});

describe('cleanMoodText', () => {
  it('去除代码块标记和首尾空行', () => {
    expect(cleanMoodText('```markdown\ncontent\n```')).toBe('content');
  });

  it('纯文本不变', () => {
    expect(cleanMoodText('just text')).toBe('just text');
  });
});

describe('parseXingFromContent', () => {
  it('无 xing 标签返回原文', () => {
    const result = parseXingFromContent('no xing here');
    expect(result.xingBlocks).toEqual([]);
    expect(result.text).toBe('no xing here');
  });

  it('解析单个 xing 块', () => {
    const input = 'Before.\n<xing title="Test">xing content</xing>\nAfter.';
    const result = parseXingFromContent(input);
    expect(result.xingBlocks).toHaveLength(1);
    expect(result.xingBlocks[0].title).toBe('Test');
    expect(result.xingBlocks[0].content).toBe('xing content');
    expect(result.text).toContain('Before.');
    expect(result.text).toContain('After.');
  });

  it('解析多个 xing 块', () => {
    const input = '<xing title="A">aaa</xing>\n<xing title="B">bbb</xing>';
    const result = parseXingFromContent(input);
    expect(result.xingBlocks).toHaveLength(2);
    expect(result.xingBlocks[0].title).toBe('A');
    expect(result.xingBlocks[1].title).toBe('B');
  });
});

describe('parseUserAttachments', () => {
  it('纯文本无附件', () => {
    const result = parseUserAttachments('hello');
    expect(result.text).toBe('hello');
    expect(result.files).toEqual([]);
    expect(result.deskContext).toBeNull();
  });

  it('空内容', () => {
    const result = parseUserAttachments('');
    expect(result.text).toBe('');
    expect(result.files).toEqual([]);
  });

  it('解析文件附件', () => {
    const input = 'Some text\n[附件] /path/to/file.txt';
    const result = parseUserAttachments(input);
    expect(result.text).toBe('Some text');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('/path/to/file.txt');
    expect(result.files[0].name).toBe('file.txt');
    expect(result.files[0].isDirectory).toBe(false);
  });

  it('解析目录附件', () => {
    const input = '[目录] /path/to/dir';
    const result = parseUserAttachments(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].isDirectory).toBe(true);
  });

  it('解析书桌上下文', () => {
    const input = '[当前书桌目录] /home/user/desk\n  file1.txt\n  file2.txt\nSome text';
    const result = parseUserAttachments(input);
    expect(result.deskContext).not.toBeNull();
    expect(result.deskContext!.dir).toBe('/home/user/desk');
    expect(result.deskContext!.fileCount).toBe(2);
    expect(result.text).toBe('Some text');
  });
});

describe('stripPlanDraftWrapper', () => {
  it('zh 格式：剥离 plan.draftPrompt 包装，返回任务文本', () => {
    const wrapped =
      '【/plan 仅规划】\n用户任务：\n分析俄乌战争的最真实情况\n\n你必须使用 **todo** 工具将任务拆成可执行步骤。';
    expect(stripPlanDraftWrapper(wrapped)).toBe('分析俄乌战争的最真实情况');
  });

  it('en 格式：剥离 plan.draftPrompt 包装', () => {
    const wrapped =
      '[/plan — planning only]\nTask:\nAnalyze the war situation\n\nYou MUST use the **todo** tool to break the task into steps.';
    expect(stripPlanDraftWrapper(wrapped)).toBe('Analyze the war situation');
  });

  it('非 plan 消息原样返回', () => {
    expect(stripPlanDraftWrapper('hello world')).toBe('hello world');
  });

  it('空内容原样返回', () => {
    expect(stripPlanDraftWrapper('')).toBe('');
  });

  it('多行任务文本保留', () => {
    const wrapped =
      '【/plan 仅规划】\n用户任务：\n第一行\n第二行\n\n你必须使用 **todo** 工具';
    expect(stripPlanDraftWrapper(wrapped)).toBe('第一行\n第二行');
  });
});

describe('truncatePath', () => {
  it('短路径不截断', () => {
    expect(truncatePath('/short')).toBe('/short');
  });

  it('长路径截断带省略号', () => {
    const long = '/very/long/path/that/exceeds/thirty/five/chars/file.txt';
    const result = truncatePath(long);
    expect(result.startsWith('…')).toBe(true);
    expect(result.length).toBe(35);
  });

  it('空字符串返回空', () => {
    expect(truncatePath('')).toBe('');
  });
});

describe('extractHostname', () => {
  it('提取域名', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com');
  });

  it('无效 URL 返回原文', () => {
    expect(extractHostname('not-a-url')).toBe('not-a-url');
  });

  it('空字符串返回空', () => {
    expect(extractHostname('')).toBe('');
  });
});

describe('truncateHead', () => {
  it('短文本不截断', () => {
    expect(truncateHead('short', 10)).toBe('short');
  });

  it('长文本截断带省略号', () => {
    expect(truncateHead('this is long text', 10)).toBe('this is l…');
  });
});

describe('extractToolDetail', () => {
  it('read 工具提取文件路径', () => {
    expect(extractToolDetail('read', { file_path: '/a/b.txt' })).toContain('b.txt');
  });

  it('bash 工具提取命令', () => {
    expect(extractToolDetail('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('web_search 提取查询', () => {
    expect(extractToolDetail('web_search', { query: 'test query' })).toBe('test query');
  });

  it('未知工具返回空', () => {
    expect(extractToolDetail('unknown_tool', { foo: 'bar' })).toBe('');
  });

  it('无 args 返回空', () => {
    expect(extractToolDetail('read', undefined)).toBe('');
  });
});

describe('extractToolDetailFull', () => {
  it('grep 返回完整 pattern 与路径', () => {
    const longPat = 'coding|token|plan|subscription|verylongsuffix';
    const longPath = '/Users/yejohnathon/Desktop/very/deep/nested/folder';
    const args = { pattern: longPat, path: longPath };
    expect(extractToolDetailFull('grep', args)).toBe(`${longPat} in ${longPath}`);
    expect(extractToolDetail('grep', args)).not.toBe(extractToolDetailFull('grep', args));
  });

  it('web_search 返回完整查询', () => {
    const q = 'cheapest AI coding assistant subscription';
    expect(extractToolDetailFull('web_search', { query: q })).toBe(q);
  });

  it('未知工具返回格式化的 JSON', () => {
    const s = extractToolDetailFull('custom_tool', { a: 1, b: 'x' });
    expect(s).toContain('"a"');
    expect(s).toContain('"b"');
  });
});

describe('/plan merge: extractTodosFromAddText', () => {
  it('多行编号拆成多条', () => {
    const t = '1. 第一步\n2. 第二步\n3. 第三步';
    expect(extractTodosFromAddText(t)).toEqual(['第一步', '第二步', '第三步']);
  });

  it('单行不拆', () => {
    expect(extractTodosFromAddText('只做一件事')).toEqual(['只做一件事']);
  });
});

describe('/plan merge: extractPlanStepsFromAssistantBlocks', () => {
  it('从 HTML 表格解析序号列与步骤列', () => {
    const html =
      '<table><tbody>' +
      '<tr><td>1</td><td>搜索最新动态</td></tr>' +
      '<tr><td>2</td><td>收集多方信源</td></tr>' +
      '</tbody></table>';
    expect(extractPlanStepsFromAssistantBlocks([{ type: 'text', html }])).toEqual([
      '搜索最新动态',
      '收集多方信源',
    ]);
  });
});

describe('/plan merge: mergePlanDraftTodosFromBlocks', () => {
  it('正文表格条数多于单次 todo add 时采用表格', () => {
    const tableHtml =
      '<table><tbody>' +
      '<tr><td>1</td><td>A</td></tr>' +
      '<tr><td>2</td><td>B</td></tr>' +
      '<tr><td>3</td><td>C</td></tr>' +
      '</tbody></table>';
    const blocks = [
      {
        type: 'tool_group' as const,
        tools: [{ name: 'todo', args: { action: 'add', text: '仅一条' }, done: true, success: true }],
        collapsed: true,
      },
      { type: 'text' as const, html: tableHtml },
    ];
    const got = mergePlanDraftTodosFromBlocks(blocks);
    expect(got).toHaveLength(3);
    expect(got.map(t => t.text)).toEqual(['A', 'B', 'C']);
  });
});

describe('expandTodosNumberedLines', () => {
  it('展开单条 todo 内多行编号', () => {
    const expanded = expandTodosNumberedLines([
      { id: 1, text: '1. a\n2. b', done: false },
    ]);
    expect(expanded).toHaveLength(2);
    expect(expanded.map(t => t.text)).toEqual(['a', 'b']);
  });
});

describe('moodLabel', () => {
  it('hanako 返回 MOOD', () => {
    expect(moodLabel('hanako')).toContain('MOOD');
  });

  it('butter 返回 PULSE', () => {
    expect(moodLabel('butter')).toContain('PULSE');
  });

  it('未知 yuan 降级为 MOOD', () => {
    expect(moodLabel('unknown')).toContain('MOOD');
  });
});
