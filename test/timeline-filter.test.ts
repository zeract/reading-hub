import { describe, expect, it } from "vitest";
import { DEFAULT_TIMELINE_FILTER, defaultCustomTimelineDates, resolveTimelineRange, timelineQuery } from "../src/renderer/timeline-filter";

describe("timeline time filter", () => {
  const now = new Date(2026, 7, 16, 14, 30);

  it("resolves calendar presets as local, end-exclusive ranges", () => {
    const range = resolveTimelineRange({ ...DEFAULT_TIMELINE_FILTER, preset: "sevenDays" }, now);
    expect(range).toMatchObject({ hasRange: true, invalid: false, label: "最近 7 天" });
    expect(new Date(range.startAt!).toString()).toContain("Aug 10 2026 00:00:00");
    expect(new Date(range.endAt!).toString()).toContain("Aug 17 2026 00:00:00");
  });

  it("includes the complete custom end date without accepting an inverted range", () => {
    const range = resolveTimelineRange({ preset: "custom", startDate: "2026-08-10", endDate: "2026-08-16" }, now);
    expect(range).toMatchObject({ hasRange: true, invalid: false, label: "2026-08-10 至 2026-08-16" });
    expect(new Date(range.endAt!).toString()).toContain("Aug 17 2026 00:00:00");
    expect(resolveTimelineRange({ preset: "custom", startDate: "2026-08-17", endDate: "2026-08-16" }, now).invalid).toBe(true);
  });

  it("keeps the all-time list bounded but asks the database for every explicitly filtered item", () => {
    expect(timelineQuery("source-a", resolveTimelineRange(DEFAULT_TIMELINE_FILTER, now))).toEqual({ sourceId: "source-a", limit: 200 });
    const range = resolveTimelineRange({ ...DEFAULT_TIMELINE_FILTER, preset: "today" }, now);
    expect(timelineQuery("source-a", range)).toEqual({ sourceId: "source-a", startAt: range.startAt, endAt: range.endAt });
  });

  it("starts the custom control at a useful last-30-days interval", () => {
    expect(defaultCustomTimelineDates(now)).toEqual({ startDate: "2026-07-18", endDate: "2026-08-16" });
  });
});
