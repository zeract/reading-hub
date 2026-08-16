import type { EntryListQuery } from "../shared/types";

export type TimelineRangePreset = "all" | "today" | "sevenDays" | "thirtyDays" | "ninetyDays" | "thisYear" | "custom";

export type TimelineRangeFilter = {
  preset: TimelineRangePreset;
  startDate: string;
  endDate: string;
};

export type ResolvedTimelineRange = {
  startAt?: number;
  endAt?: number;
  hasRange: boolean;
  invalid: boolean;
  label: string;
};

export const DEFAULT_TIMELINE_FILTER: TimelineRangeFilter = {
  preset: "all",
  startDate: "",
  endDate: ""
};

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function parseLocalDate(value: string): Date | undefined {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return undefined;
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  if (date.getFullYear() !== Number(matched[1]) || date.getMonth() !== Number(matched[2]) - 1 || date.getDate() !== Number(matched[3])) return undefined;
  return date;
}

function formatDateInput(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const date = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function formatRangeLabel(startDate?: string, endDate?: string): string {
  if (startDate && endDate) return `${startDate} 至 ${endDate}`;
  if (startDate) return `${startDate} 起`;
  if (endDate) return `截至 ${endDate}`;
  return "全部时间";
}

/** Resolves calendar presets in the user's local timezone. */
export function resolveTimelineRange(filter: TimelineRangeFilter, now = new Date()): ResolvedTimelineRange {
  const today = startOfLocalDay(now);
  const tomorrow = addLocalDays(today, 1);
  switch (filter.preset) {
    case "all":
      return { hasRange: false, invalid: false, label: "全部时间" };
    case "today":
      return { startAt: today.getTime(), endAt: tomorrow.getTime(), hasRange: true, invalid: false, label: "今天" };
    case "sevenDays":
      return { startAt: addLocalDays(today, -6).getTime(), endAt: tomorrow.getTime(), hasRange: true, invalid: false, label: "最近 7 天" };
    case "thirtyDays":
      return { startAt: addLocalDays(today, -29).getTime(), endAt: tomorrow.getTime(), hasRange: true, invalid: false, label: "最近 30 天" };
    case "ninetyDays":
      return { startAt: addLocalDays(today, -89).getTime(), endAt: tomorrow.getTime(), hasRange: true, invalid: false, label: "最近 90 天" };
    case "thisYear": {
      const yearStart = new Date(today.getFullYear(), 0, 1);
      const nextYearStart = new Date(today.getFullYear() + 1, 0, 1);
      return { startAt: yearStart.getTime(), endAt: nextYearStart.getTime(), hasRange: true, invalid: false, label: `${today.getFullYear()} 年` };
    }
    case "custom": {
      const start = filter.startDate ? parseLocalDate(filter.startDate) : undefined;
      const end = filter.endDate ? parseLocalDate(filter.endDate) : undefined;
      const invalidDate = Boolean((filter.startDate && !start) || (filter.endDate && !end));
      const startAt = start?.getTime();
      const endAt = end ? addLocalDays(end, 1).getTime() : undefined;
      const invalidRange = startAt !== undefined && endAt !== undefined && endAt <= startAt;
      return {
        startAt,
        endAt,
        hasRange: startAt !== undefined || endAt !== undefined,
        invalid: invalidDate || invalidRange,
        label: formatRangeLabel(filter.startDate || undefined, filter.endDate || undefined)
      };
    }
  }
}

export function timelineQuery(sourceId: string | undefined, range: ResolvedTimelineRange): EntryListQuery {
  return {
    sourceId,
    startAt: range.startAt,
    endAt: range.endAt,
    // Keep the original timeline cap only for the unfiltered all-time view.
    ...(range.hasRange ? {} : { limit: 200 })
  };
}

export function defaultCustomTimelineDates(now = new Date()): Pick<TimelineRangeFilter, "startDate" | "endDate"> {
  const today = startOfLocalDay(now);
  return {
    startDate: formatDateInput(addLocalDays(today, -29)),
    endDate: formatDateInput(today)
  };
}
