import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findManyUsers: vi.fn(),
  updateManyGoals: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findMany: mocks.findManyUsers },
    goal: { updateMany: mocks.updateManyGoals },
  },
}));

import { localDateString, scanOverdueGoals } from "../src/lib/goals.js";

describe("localDateString", () => {
  it("returns different local dates for the same instant across timezones", () => {
    const now = new Date("2026-10-04T16:30:00.000Z");
    expect(localDateString(now, "Asia/Shanghai")).toBe("2026-10-05");
    expect(localDateString(now, "UTC")).toBe("2026-10-04");
    expect(localDateString(now, "America/New_York")).toBe("2026-10-04");
  });

  it("flips the date exactly at local midnight", () => {
    const before = new Date("2026-10-04T15:59:59.000Z");
    const after = new Date("2026-10-04T16:00:00.000Z");
    expect(localDateString(before, "Asia/Shanghai")).toBe("2026-10-04");
    expect(localDateString(after, "Asia/Shanghai")).toBe("2026-10-05");
  });

  it("supports timezones with non-whole-hour offsets", () => {
    const now = new Date("2026-10-04T18:20:00.000Z");
    expect(localDateString(now, "Asia/Kathmandu")).toBe("2026-10-05");
    expect(localDateString(now, "UTC")).toBe("2026-10-04");
  });
});

describe("scanOverdueGoals", () => {
  beforeEach(() => {
    mocks.findManyUsers.mockReset();
    mocks.updateManyGoals.mockReset();
  });

  it("marks goals overdue by each user's local date instead of the UTC date", async () => {
    // 同一时刻：上海本地已是 10-05（dueDate<=10-04 逾期），纽约本地仍是 10-04（仅 dueDate<=10-03 逾期）
    const now = new Date("2026-10-04T16:30:00.000Z");
    mocks.findManyUsers.mockResolvedValue([{ timezone: "Asia/Shanghai" }, { timezone: "America/New_York" }]);
    mocks.updateManyGoals.mockResolvedValue({ count: 1 });

    const result = await scanOverdueGoals(now);

    expect(mocks.updateManyGoals).toHaveBeenCalledTimes(2);
    const byTimezone = new Map(
      mocks.updateManyGoals.mock.calls.map(([arg]) => [arg.where.user.timezone as string, arg]),
    );
    expect(byTimezone.get("Asia/Shanghai")?.where.dueDate).toEqual({ lt: new Date("2026-10-05T00:00:00.000Z") });
    expect(byTimezone.get("America/New_York")?.where.dueDate).toEqual({ lt: new Date("2026-10-04T00:00:00.000Z") });
    expect(result.marked).toBe(2);
    expect(result.skippedTimezones).toEqual([]);
  });

  it("keeps goals due on the user's local today open", async () => {
    // 纽约本地仍是 10-04，截止日为 10-04 的目标不应被扫描命中（lt 本地今天）
    const now = new Date("2026-10-04T16:30:00.000Z");
    mocks.findManyUsers.mockResolvedValue([{ timezone: "America/New_York" }]);
    mocks.updateManyGoals.mockResolvedValue({ count: 0 });

    await scanOverdueGoals(now);

    const [arg] = mocks.updateManyGoals.mock.calls[0] ?? [];
    expect(arg?.where.dueDate).toEqual({ lt: new Date("2026-10-04T00:00:00.000Z") });
  });

  it("is idempotent: repeated scans only touch OPEN/IN_PROGRESS goals", async () => {
    const now = new Date("2026-10-04T16:30:00.000Z");
    mocks.findManyUsers.mockResolvedValue([{ timezone: "Asia/Shanghai" }]);
    mocks.updateManyGoals.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 0 });

    const first = await scanOverdueGoals(now);
    const second = await scanOverdueGoals(now);

    expect(first.marked).toBe(3);
    expect(second.marked).toBe(0);
    for (const [arg] of mocks.updateManyGoals.mock.calls) {
      expect(arg.where.status).toEqual({ in: ["OPEN", "IN_PROGRESS"] });
      expect(arg.data).toEqual({ status: "MISSED" });
    }
  });

  it("skips invalid timezones instead of failing the whole scan", async () => {
    mocks.findManyUsers.mockResolvedValue([{ timezone: "Mars/Olympus" }, { timezone: "Asia/Shanghai" }]);
    mocks.updateManyGoals.mockResolvedValue({ count: 1 });

    const result = await scanOverdueGoals(new Date("2026-10-04T16:30:00.000Z"));

    expect(result.skippedTimezones).toEqual(["Mars/Olympus"]);
    expect(mocks.updateManyGoals).toHaveBeenCalledTimes(1);
    expect(result.marked).toBe(1);
  });

  it("does nothing when no open goals exist", async () => {
    mocks.findManyUsers.mockResolvedValue([]);

    const result = await scanOverdueGoals(new Date("2026-10-04T16:30:00.000Z"));

    expect(mocks.updateManyGoals).not.toHaveBeenCalled();
    expect(result.marked).toBe(0);
  });
});
