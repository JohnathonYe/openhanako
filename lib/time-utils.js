/**
 * time-utils.js — 日界线 + 逻辑日期工具
 *
 * 系统全局以凌晨 4:00 为日界线（4:00 前算前一天）。
 * 日记、记忆编译、滚动摘要等模块共享此定义。
 */

export const DAY_BOUNDARY_HOUR = 4;

/**
 * 计算逻辑日期：4:00 前算前一天
 * @param {Date} [now]
 * @returns {{ logicalDate: string, rangeStart: Date, rangeEnd: Date }}
 */
export function getLogicalDay(now = new Date()) {
  const base = new Date(now);
  if (base.getHours() < DAY_BOUNDARY_HOUR) base.setDate(base.getDate() - 1);

  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  const logicalDate = `${yyyy}-${mm}-${dd}`;

  const rangeStart = new Date(base);
  rangeStart.setHours(DAY_BOUNDARY_HOUR, 0, 0, 0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  return { logicalDate, rangeStart, rangeEnd };
}

/**
 * 「刚结束」的逻辑日：在日界瞬间（如 4:00:00）用 now-1ms 得到上一完整逻辑区间。
 * 仅用于边界触发时刻；其它时刻请用 getLastCompletedLogicalDay。
 */
export function getLogicalDayForJustEndedPeriod(now = new Date()) {
  const d = new Date(now);
  d.setMilliseconds(d.getMilliseconds() - 1);
  return getLogicalDay(d);
}

/**
 * 最近一个**已结束**的完整逻辑日（用于日界自动日记补写、漏跑补偿）。
 * - 4:00 前：上一完整区间为「前天 4 点～昨天 4 点」对应的 logicalDate
 * - 4:00 及以后：上一完整区间为「昨天 4 点～今天 4 点」对应的 logicalDate
 */
export function getLastCompletedLogicalDay(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < DAY_BOUNDARY_HOUR) {
    const x = new Date(d);
    x.setDate(x.getDate() - 2);
    x.setHours(DAY_BOUNDARY_HOUR + 6, 0, 0, 0);
    return getLogicalDay(x);
  }
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  y.setHours(DAY_BOUNDARY_HOUR + 6, 0, 0, 0);
  return getLogicalDay(y);
}
