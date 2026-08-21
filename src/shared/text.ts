export function compactText(value?: string, max = 500): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function parsePublishedAt(value?: string): number | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  // An ISO timestamp continues with `T`, which is also a word character, so a
  // trailing word boundary would reject values such as `2026-08-16T12:00:00Z`.
  // Accept only a date on its own or a date followed by the normal timestamp
  // separator; this keeps unrelated strings from being treated as dates.
  const isoDate = text.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?=$|[Tt\s])/);
  if (isoDate) return dateAtUtc(isoDate[1], isoDate[2], isoDate[3]);

  const chineseDate = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})/);
  if (chineseDate) {
    const [, year, month, day] = chineseDate;
    return dateAtUtc(year, month, day);
  }

  // List cards often concatenate their date and title in separate inline
  // elements (for example `Jul 29, 2026Research note`). A named month plus a
  // four-digit year is unambiguous enough to accept as long as it is not
  // followed by another digit; a word boundary would incorrectly reject it.
  const namedDayFirst = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s*,?\s*(20\d{2})(?!\d)/i);
  if (namedDayFirst) return dateAtUtc(namedDayFirst[3], monthNumber(namedDayFirst[2]), namedDayFirst[1]);

  const namedMonthFirst = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})(?!\d)/i);
  if (namedMonthFirst) return dateAtUtc(namedMonthFirst[3], monthNumber(namedMonthFirst[1]), namedMonthFirst[2]);

  // `Date.parse` interprets arbitrary text such as "Ubuntu 12.04" as a
  // date. Only delegate fully date-like strings to it after the explicit
  // formats above have been handled.
  if (/^\d{1,2}[./-]\d{1,2}[./-]20\d{2}(?:\s+.*)?$/.test(text)) {
    const direct = Date.parse(text);
    if (!Number.isNaN(direct)) return direct;
  }
  return undefined;
}

function monthNumber(value: string): number {
  const month = value.slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(month) + 1;
}

function dateAtUtc(year: string, month: string | number, day: string): number | undefined {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  if (numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > 31) return undefined;
  const parsed = Date.UTC(numericYear, numericMonth - 1, numericDay);
  const date = new Date(parsed);
  return date.getUTCFullYear() === numericYear && date.getUTCMonth() === numericMonth - 1 && date.getUTCDate() === numericDay ? parsed : undefined;
}
