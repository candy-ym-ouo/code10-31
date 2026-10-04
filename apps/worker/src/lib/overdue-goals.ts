import { Prisma, type PrismaClient } from "@prisma/client";

export const ACTIVE_GOAL_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

/** 每小时补偿扫描一次，保证任意时区用户越过本地日界后 1 小时内被标记。 */
export const OVERDUE_SCAN_INTERVAL_MS = 60 * 60_000;

/** 单次 IN 查询的用户数上限，避免一条 SQL 绑定过多参数。 */
const TIMEZONE_CHUNK_SIZE = 200;

export interface ScanLogger {
  info: (data: Record<string, unknown>, message: string) => void;
  warn?: (data: Record<string, unknown>, message: string) => void;
  error?: (data: Record<string, unknown>, message: string) => void;
}

export interface UserTimezoneRow {
  id: string;
  timezone: string;
}

export interface ScanBucket {
  /** 该分组中各用户本地的“今天”日历日期（YYYY-MM-DD）。 */
  localDate: string;
  /** 本地今天相同的用户，可共用一次按日期比较的更新。 */
  userIds: string[];
  /** 数据库中存在但 Intl 无法识别的时区，已按 UTC 兜底，仅用于告警。 */
  invalidTimezones: string[];
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回指定时刻在用户时区下的本地日历日期（YYYY-MM-DD）。
 * 逾期判定必须基于这一日期，而不是 UTC 日期：UTC+12 的用户最早越过日界，
 * UTC-12 的用户最晚，两者相差整整一天。
 */
export function getLocalCalendarDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * 按“用户本地今天”对用户分组。无效时区不会导致整轮扫描失败，
 * 而是回退到 UTC 并在 invalidTimezones 中记录，便于运营修正用户配置。
 */
export function buildScanPlan(rows: UserTimezoneRow[], now: Date): ScanBucket[] {
  const byDate = new Map<string, ScanBucket>();
  const bucketFor = (localDate: string): ScanBucket => {
    const existing = byDate.get(localDate);
    if (existing) return existing;
    const bucket: ScanBucket = { localDate, userIds: [], invalidTimezones: [] };
    byDate.set(localDate, bucket);
    return bucket;
  };

  for (const row of rows) {
    const valid = isValidTimezone(row.timezone);
    if (!valid) bucketFor(getLocalCalendarDate(now, "UTC")).invalidTimezones.push(row.timezone);
    bucketFor(getLocalCalendarDate(now, valid ? row.timezone : "UTC")).userIds.push(row.id);
  }
  return [...byDate.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * 按各用户时区的本地日界标记逾期目标：
 * dueDate 是纯日历日期（DB date），只有当它严格早于用户本地的“今天”时，
 * 目标才在本地日界后逾期。
 *
 * 幂等性：WHERE 只匹配 OPEN / IN_PROGRESS 且仍未逾期的行，重复扫描不会改动
 * 已是 MISSED / ACHIEVED / CANCELLED 的目标，也不会刷新它们的 updated_at 或
 * version；重新激活的目标若新的 dueDate 仍在过去，则可以再次被标记。
 */
export async function scanOverdueGoals(
  prisma: PrismaClient | Prisma.TransactionClient,
  now: Date,
  logger?: ScanLogger,
): Promise<number> {
  const rows = await prisma.user.findMany({
    where: { goals: { some: { status: { in: [...ACTIVE_GOAL_STATUSES] } } } },
    select: { id: true, timezone: true },
  });

  const plan = buildScanPlan(rows, now);
  for (const bucket of plan) {
    if (bucket.invalidTimezones.length > 0) {
      logger?.warn?.(
        { timezones: [...new Set(bucket.invalidTimezones)], fallback: "UTC" },
        "invalid user timezone fallback to UTC",
      );
    }
  }

  let total = 0;
  for (const bucket of plan) {
    for (const userIds of chunk(bucket.userIds, TIMEZONE_CHUNK_SIZE)) {
      // 与 statistics-service 的 AT TIME ZONE 口径一致，日期比较全部在 SQL 中
      // 显式以 date 类型完成，不依赖数据库会话时区。
      const result = await prisma.$executeRaw`
        UPDATE goals AS g
        SET status = 'MISSED'::"GoalStatus",
            version = g.version + 1,
            updated_at = ${now}
        WHERE g.user_id IN (${Prisma.join(userIds)})
          AND g.due_date < ${bucket.localDate}::date
          AND g.status::text IN ('OPEN', 'IN_PROGRESS')
      `;
      total += result;
    }
  }

  if (total > 0) logger?.info?.({ count: total }, "overdue goals marked missed");
  return total;
}
