/** Tính tiền buổi học 1 kèm 1 = học phí + phí sân (phí sân đổi giá lúc 17:00, khác nhau ngày thường/cuối tuần). */
import { COURT_FEE, PRIVATE_TUITION_PER_HOUR } from "./config";
import { epochToVnDate, vnToEpoch, vnWeekday } from "./time";

export interface Quote {
  tuition: number;
  court: number;
  total: number;
  courtDetail: string;
}

export const vnd = (n: number) => `${Math.round(n / 1000).toLocaleString("vi-VN")}k`;

export function quotePrivate(start: number, durationMin: number): Quote {
  const end = start + durationMin * 60_000;
  const weekend = [0, 6].includes(vnWeekday(start));
  const dayRate = weekend ? COURT_FEE.weekendDay : COURT_FEE.weekdayDay;
  const eveningStart = vnToEpoch(epochToVnDate(start), COURT_FEE.eveningFrom)!;

  const dayMin = Math.max(0, Math.min(end, eveningStart) - start) / 60_000;
  const eveMin = durationMin - dayMin;
  const court = (dayMin / 60) * dayRate + (eveMin / 60) * COURT_FEE.evening;
  const tuition = (durationMin / 60) * PRIVATE_TUITION_PER_HOUR;

  const parts: string[] = [];
  if (dayMin > 0) parts.push(`${dayMin / 60} giờ × ${vnd(dayRate)}`);
  if (eveMin > 0) parts.push(`${eveMin / 60} giờ × ${vnd(COURT_FEE.evening)} (sau ${COURT_FEE.eveningFrom})`);
  return { tuition, court, total: tuition + court, courtDetail: parts.join(" + ") };
}

export function describeQuote(q: Quote): string {
  return `Học phí ${vnd(q.tuition)} + phí sân ${vnd(q.court)} (${q.courtDetail}) = tổng ${vnd(q.total)}`;
}
