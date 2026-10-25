const pad = (value: number) => String(value).padStart(2, '0');

/** The local calendar day of a UTC instant, as `YYYY-MM-DD`; vault titles and folders use local time. */
export function localDay(instantUtc: string): string {
  const date = new Date(instantUtc);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `HH.MM.SS`; colons are not allowed in note titles. */
export function localTime(instantUtc: string): string {
  const date = new Date(instantUtc);
  return `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}
