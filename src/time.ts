/** Giờ Việt Nam: UTC+7 cố định (không có giờ mùa hè). */
export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
export const VN_TZ = "Asia/Ho_Chi_Minh";

const WEEKDAYS_VI = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-24" + "17:30" -> epoch ms (giờ VN). Trả về null nếu sai định dạng. */
export function vnToEpoch(date: string, time = "00:00"): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi] = [Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, da, h, mi) - VN_OFFSET_MS;
  // Chặn ngày không tồn tại (vd 31/02) bị Date.UTC tự cuộn sang tháng sau.
  if (epochToVnDate(ms) !== date) return null;
  return ms;
}

/** "2026-11-24T17:30" -> epoch ms. */
export function vnDateTimeToEpoch(dateTime: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/.exec(dateTime.trim());
  return m ? vnToEpoch(m[1]!, m[2]!) : null;
}

function shifted(ms: number): Date {
  return new Date(ms + VN_OFFSET_MS);
}

export function epochToVnDate(ms: number): string {
  const d = shifted(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function epochToVnTime(ms: number): string {
  const d = shifted(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 0 = Chủ nhật ... 6 = Thứ 7 */
export function vnWeekday(ms: number): number {
  return shifted(ms).getUTCDay();
}

/** "Thứ 3, 24/11/2026 17:30" */
export function formatVn(ms: number): string {
  const d = shifted(ms);
  return `${WEEKDAYS_VI[d.getUTCDay()]}, ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${epochToVnTime(ms)}`;
}

/** ISO 8601 có offset +07:00, dùng cho Google Calendar. */
export function toRfc3339Vn(ms: number): string {
  return `${epochToVnDate(ms)}T${epochToVnTime(ms)}:00+07:00`;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Tính các giờ bắt đầu còn trống trong một ngày.
 * @param workingRanges khung giờ dạy của ngày đó, vd [["05:30","08:30"]]
 * @param busy các khoảng đã bận (từ Google Calendar)
 * @param earliest không gợi ý giờ trước thời điểm này (now + thời gian báo trước tối thiểu)
 */
export function freeSlots(
  date: string,
  workingRanges: Array<[string, string]>,
  durationMin: number,
  stepMin: number,
  busy: Interval[],
  earliest: number,
): number[] {
  const out: number[] = [];
  const dur = durationMin * 60_000;
  for (const [from, to] of workingRanges) {
    const rangeStart = vnToEpoch(date, from);
    const rangeEnd = vnToEpoch(date, to);
    if (rangeStart === null || rangeEnd === null) continue;
    for (let s = rangeStart; s + dur <= rangeEnd; s += stepMin * 60_000) {
      if (s < earliest) continue;
      const slot = { start: s, end: s + dur };
      if (!busy.some((b) => overlaps(slot, b))) out.push(s);
    }
  }
  return out;
}

/** Kiểm tra một buổi học có nằm trọn trong khung giờ dạy của ngày không. */
export function withinWorkingHours(
  start: number,
  durationMin: number,
  hours: Record<number, Array<[string, string]>>,
): boolean {
  const date = epochToVnDate(start);
  const end = start + durationMin * 60_000;
  return (hours[vnWeekday(start)] ?? []).some(([from, to]) => {
    const a = vnToEpoch(date, from);
    const b = vnToEpoch(date, to);
    return a !== null && b !== null && start >= a && end <= b;
  });
}
