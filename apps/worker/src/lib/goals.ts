import { prisma } from "./prisma.js";

/**
 * 逾期扫描间隔：每小时一次。
 * 各地用户的本地日界（含 30/45 分钟偏移的时区）都会在这一小时内被覆盖到，
 * 避免 24 小时间隔带来的额外滞后。
 */
export const OVERDUE_SCAN_INTERVAL_MS = 60 * 60_000;

export interface OverdueScanResult {
  marked: number;
  skippedTimezones: string[];
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** 计算某一时刻在指定 IANA 时区下的本地日历日期（YYYY-MM-DD）。 */
export function localDateString(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * 把本地今天已经过去的未关闭目标标记为 MISSED。
 *
 * 判定基于每个用户自己时区的本地日期：只有当 dueDate 严格早于用户本地今天时
 * 才算逾期（截止日当天本地时间内仍可完成）。WHERE 中的状态过滤保证重复扫描
 * 不会重复改写已逾期目标，重复执行是幂等的。
 */
export async function scanOverdueGoals(now: Date = new Date()): Promise<OverdueScanResult> {
  const timezoneRows = await prisma.user.findMany({
    where: { goals: { some: { status: { in: ["OPEN", "IN_PROGRESS"] } } } },
    select: { timezone: true },
    distinct: ["timezone"],
  });
  const result: OverdueScanResult = { marked: 0, skippedTimezones: [] };
  for (const { timezone } of timezoneRows) {
    if (!isIanaTimezone(timezone)) {
      result.skippedTimezones.push(timezone);
      continue;
    }
    const localToday = new Date(`${localDateString(now, timezone)}T00:00:00.000Z`);
    const { count } = await prisma.goal.updateMany({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        dueDate: { lt: localToday },
        user: { timezone },
      },
      data: { status: "MISSED" },
    });
    result.marked += count;
  }
  return result;
}
