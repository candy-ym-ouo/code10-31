import { describe, expect, it } from "vitest";
import { buildScanPlan, getLocalCalendarDate, isValidTimezone } from "../src/lib/overdue-goals.js";

// 选取一个能同时覆盖三个本地日期的 UTC 时刻：2026-10-04T11:30:00Z
// UTC-12 仍在 10-03，UTC 附近是 10-04，UTC+13/+14 已是 10-05。
const INSTANT = new Date("2026-10-04T11:30:00Z");

describe("getLocalCalendarDate", () => {
  it("returns the UTC calendar date for UTC", () => {
    expect(getLocalCalendarDate(INSTANT, "UTC")).toBe("2026-10-04");
  });

  it("uses the local date east of UTC after the local midnight boundary", () => {
    // 上海 UTC+8：本地 19:30，仍是 10-04
    expect(getLocalCalendarDate(INSTANT, "Asia/Shanghai")).toBe("2026-10-04");
    // 奥克兰 UTC+13（10 月为夏令时）：本地 10-05 00:30，已越过本地日界
    expect(getLocalCalendarDate(INSTANT, "Pacific/Auckland")).toBe("2026-10-05");
    // 基里巴斯 UTC+14：本地 10-05 01:30，已是第二天
    expect(getLocalCalendarDate(INSTANT, "Pacific/Kiritimati")).toBe("2026-10-05");
  });

  it("keeps the previous local date west of UTC before local midnight", () => {
    // 洛杉矶 UTC-7（10 月为夏令时）：本地 04:30，仍是 10-04
    expect(getLocalCalendarDate(INSTANT, "America/Los_Angeles")).toBe("2026-10-04");
    // 帕果帕果 UTC-11：本地 10-04 00:30，刚越过本地日界
    expect(getLocalCalendarDate(INSTANT, "Pacific/Pago_Pago")).toBe("2026-10-04");
    // UTC-12（Etc/GMT+12）：本地 10-03 23:30，尚未越过本地日界
    expect(getLocalCalendarDate(INSTANT, "Etc/GMT+12")).toBe("2026-10-03");
  });

  it("rolls over the local date exactly at the local midnight boundary", () => {
    // 上海 UTC+8 的本地 10-05 00:00 == 10-04T16:00Z
    expect(getLocalCalendarDate(new Date("2026-10-04T15:59:59Z"), "Asia/Shanghai")).toBe("2026-10-04");
    expect(getLocalCalendarDate(new Date("2026-10-04T16:00:00Z"), "Asia/Shanghai")).toBe("2026-10-05");
  });

  it("handles the northern-hemisphere DST spring-forward day", () => {
    // 洛杉矶 2026-03-08 02:00 -> 03:00 跳变；当天 10:00Z 是本地 03:00
    const springForward = new Date("2026-03-08T10:00:00Z");
    expect(getLocalCalendarDate(springForward, "America/Los_Angeles")).toBe("2026-03-08");
    expect(getLocalCalendarDate(springForward, "UTC")).toBe("2026-03-08");
  });
});

describe("isValidTimezone", () => {
  it("accepts canonical IANA zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
  });

  it("rejects fixed offsets and garbage", () => {
    expect(isValidTimezone("UTC+8")).toBe(false);
    expect(isValidTimezone("GMT+08:00")).toBe(false);
    expect(isValidTimezone("Asia/NoSuchPlace")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("buildScanPlan", () => {
  it("groups users whose local today is the same and collapses duplicates", () => {
    const plan = buildScanPlan(
      [
        { id: "u1", timezone: "UTC" },
        { id: "u2", timezone: "Europe/London" }, // 10 月伦敦 UTC+1，11:30Z 本地同为 10-04
        { id: "u3", timezone: "Asia/Shanghai" },
      ],
      INSTANT,
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.localDate).toBe("2026-10-04");
    expect(plan[0]?.userIds.sort()).toEqual(["u1", "u2", "u3"]);
    expect(plan[0]?.invalidTimezones).toEqual([]);
  });

  it("places users on opposite sides of the international date line in different dates", () => {
    const plan = buildScanPlan(
      [
        { id: "east", timezone: "Pacific/Kiritimati" }, // 本地 10-05
        { id: "west", timezone: "Etc/GMT+12" }, // 本地 10-03
        { id: "center", timezone: "UTC" }, // 本地 10-04
      ],
      INSTANT,
    );
    plan.sort((a, b) => a.localDate.localeCompare(b.localDate));

    expect(plan.map((bucket) => bucket.localDate)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(plan[0]?.userIds).toEqual(["west"]);
    expect(plan[1]?.userIds).toEqual(["center"]);
    expect(plan[2]?.userIds).toEqual(["east"]);
  });

  it("falls back to UTC for invalid timezones and records them for warning logs", () => {
    const plan = buildScanPlan(
      [
        { id: "ok", timezone: "UTC" },
        { id: "bad", timezone: "UTC+8" },
      ],
      INSTANT,
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.userIds.sort()).toEqual(["bad", "ok"]);
    expect(plan[0]?.invalidTimezones).toEqual(["UTC+8"]);
  });

  it("returns no buckets when there are no candidate users", () => {
    expect(buildScanPlan([], INSTANT)).toEqual([]);
  });
});
