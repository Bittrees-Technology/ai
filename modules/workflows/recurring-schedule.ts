/** The explicitly supported RRULE subset. Unknown clauses fail closed. */
export function parseRecurringSchedule(value: string) {
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const [key, entry, extra] = part.split("=");
    if (
      !key ||
      !entry ||
      extra ||
      fields.has(key) ||
      !["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "BYSECOND"].includes(
        key,
      )
    )
      throw Error("Unsupported recurring schedule");
    fields.set(key, entry);
  }
  const frequency = fields.get("FREQ");
  if (!["MINUTELY", "HOURLY", "DAILY", "WEEKLY"].includes(frequency || ""))
    throw Error("Unsupported recurring frequency");
  const number = (key: string, fallback: number, max: number) => {
    const raw = fields.get(key);
    if (raw !== undefined && !/^\d+$/.test(raw))
      throw Error("Invalid schedule number");
    const result = raw === undefined ? fallback : Number(raw);
    if (
      !Number.isSafeInteger(result) ||
      result < (key === "INTERVAL" ? 1 : 0) ||
      result > max
    )
      throw Error("Invalid schedule number");
    return result;
  };
  const days = fields.get("BYDAY")?.split(",");
  if (
    days &&
    (new Set(days).size !== days.length ||
      days.some((d) => !["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(d)))
  )
    throw Error("Invalid schedule day");
  if (days && frequency !== "WEEKLY")
    throw Error("BYDAY requires a weekly schedule");
  if (frequency === "WEEKLY" && !days?.length)
    throw Error("Weekly schedules need explicit days");
  if (
    ["MINUTELY", "HOURLY"].includes(frequency!) &&
    [...fields.keys()].some((key) => key.startsWith("BY"))
  )
    throw Error("Elapsed schedules cannot include civil-time filters");
  return {
    frequency,
    interval: number("INTERVAL", 1, 10080),
    days,
    hour: number("BYHOUR", 0, 23),
    minute: number("BYMINUTE", 0, 59),
    second: number("BYSECOND", 0, 59),
  };
}

/** One latest slot after sleep. Never replay all missed invocations. */
export function recurringSlot(
  rrule: string,
  timezone: string,
  anchor: number,
  now: number,
): string | null {
  if (
    !Number.isSafeInteger(anchor) ||
    !Number.isSafeInteger(now) ||
    now < anchor
  )
    return null;
  const rule = parseRecurringSchedule(rrule);
  const parts = (time: number) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      })
        .formatToParts(time)
        .map((p) => [p.type, p.value]),
    );
  const date = parts(now),
    start = parts(anchor);
  if (rule.frequency === "MINUTELY" || rule.frequency === "HOURLY") {
    const period =
      rule.interval * (rule.frequency === "MINUTELY" ? 60000 : 3600000);
    const index = Math.floor((now - anchor) / period);
    return `elapsed:${index}`;
  }
  const ordinal = (p: Record<string, string>) =>
    Math.floor(
      Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000,
    );
  const today = ordinal(date),
    first = ordinal(start);
  const clock =
    Number(date.hour) * 3600 + Number(date.minute) * 60 + Number(date.second);
  if (clock < rule.hour * 3600 + rule.minute * 60 + rule.second) return null;
  if (rule.frequency === "DAILY" && (today - first) % rule.interval !== 0)
    return null;
  if (rule.frequency === "WEEKLY") {
    const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][
      new Date(today * 86400000).getUTCDay()
    ];
    const monday = (n: number) =>
      n - ((new Date(n * 86400000).getUTCDay() + 6) % 7);
    if (
      !rule.days!.includes(day!) ||
      Math.floor((monday(today) - monday(first)) / 7) % rule.interval !== 0
    )
      return null;
  }
  // Using the civil date avoids duplicate daily execution across a DST fallback.
  return `civil:${date.year}-${date.month}-${date.day}`;
}
