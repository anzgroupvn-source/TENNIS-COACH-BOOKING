/**
 * Các công cụ Claude được dùng để đặt lịch. Mọi kiểm tra quan trọng (giờ dạy,
 * trùng lịch, quyền huỷ) đều làm trong code, không giao cho model.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  COACH,
  LESSON_DURATIONS,
  DEFAULT_DURATION,
  MAX_BOOKING_DAYS_AHEAD,
  MIN_BOOKING_NOTICE_HOURS,
  MIN_CANCEL_NOTICE_HOURS,
  SLOT_STEP_MINUTES,
  WORKING_HOURS,
} from "./config";
import type { GoogleClient } from "./google";
import {
  epochToVnDate,
  epochToVnTime,
  formatVn,
  freeSlots,
  toRfc3339Vn,
  vnDateTimeToEpoch,
  vnToEpoch,
  vnWeekday,
  withinWorkingHours,
} from "./time";

export interface ToolContext {
  zaloUserId: string;
  zaloDisplayName: string;
  google: GoogleClient | null;
  notifyCoach: (text: string) => Promise<void>;
  now: () => number;
}

const durationSchema = z
  .number()
  .int()
  .refine((d) => (LESSON_DURATIONS as readonly number[]).includes(d), {
    message: `Thời lượng phải là một trong ${LESSON_DURATIONS.join(", ")} phút`,
  });

const CheckAvailability = z.object({
  date: z.string(),
  days: z.number().int().min(1).max(7),
  duration_minutes: durationSchema,
});
const CreateBooking = z.object({
  start: z.string(),
  duration_minutes: durationSchema,
  student_name: z.string().min(1).max(100),
  phone: z.string().max(30).nullable(),
  note: z.string().max(500).nullable(),
});
const CancelBooking = z.object({
  booking_id: z.string().min(1),
  reason: z.string().max(300).nullable(),
});

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "check_availability",
    description:
      "Xem các giờ bắt đầu còn trống của HLV, tính theo giờ Việt Nam. Dùng trước khi đề xuất giờ học cho học viên. " +
      "Trả về danh sách giờ trống theo từng ngày, bắt đầu từ `date` và kéo dài `days` ngày.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: { type: "string", description: "Ngày bắt đầu, dạng YYYY-MM-DD (giờ Việt Nam)." },
        days: { type: "integer", description: "Số ngày cần xem, 1–7. Hỏi 1 ngày cụ thể thì dùng 1." },
        duration_minutes: {
          type: "integer",
          description: `Thời lượng buổi học (phút): ${LESSON_DURATIONS.join(", ")}. Mặc định ${DEFAULT_DURATION}.`,
        },
      },
      required: ["date", "days", "duration_minutes"],
    },
  },
  {
    name: "create_booking",
    description:
      "Đặt một buổi học. CHỈ gọi sau khi học viên đã xác nhận rõ ràng ngày, giờ, thời lượng và tên. " +
      "Hệ thống tự kiểm tra lại giờ trống; nếu trùng sẽ báo lỗi.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        start: { type: "string", description: "Giờ bắt đầu, dạng YYYY-MM-DDTHH:mm theo giờ Việt Nam." },
        duration_minutes: { type: "integer", description: `Thời lượng (phút): ${LESSON_DURATIONS.join(", ")}.` },
        student_name: { type: "string", description: "Tên học viên." },
        phone: { type: ["string", "null"], description: "Số điện thoại nếu học viên cung cấp, không thì null." },
        note: {
          type: ["string", "null"],
          description: "Ghi chú: trình độ, mục tiêu, số người học nhóm... hoặc null.",
        },
      },
      required: ["start", "duration_minutes", "student_name", "phone", "note"],
    },
  },
  {
    name: "list_my_bookings",
    description: "Liệt kê các buổi học sắp tới mà chính người đang chat đã đặt (kèm mã lịch để huỷ).",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "cancel_booking",
    description:
      "Huỷ một buổi học của chính người đang chat. Lấy booking_id từ list_my_bookings. " +
      "CHỈ gọi sau khi học viên xác nhận muốn huỷ đúng buổi đó.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        booking_id: { type: "string", description: "Mã lịch lấy từ list_my_bookings." },
        reason: { type: ["string", "null"], description: "Lý do huỷ nếu có, không thì null." },
      },
      required: ["booking_id", "reason"],
    },
  },
];

type ToolResult = { content: string; isError?: boolean };

const err = (content: string): ToolResult => ({ content, isError: true });

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.google) {
    return err("Hệ thống đặt lịch chưa được cấu hình. Hãy xin lỗi và đề nghị học viên nhắn trực tiếp cho HLV.");
  }
  try {
    switch (name) {
      case "check_availability": {
        const p = CheckAvailability.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await checkAvailability(p.data, ctx, ctx.google);
      }
      case "create_booking": {
        const p = CreateBooking.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await createBooking(p.data, ctx, ctx.google);
      }
      case "list_my_bookings":
        return await listMyBookings(ctx, ctx.google);
      case "cancel_booking": {
        const p = CancelBooking.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await cancelBooking(p.data, ctx, ctx.google);
      }
      default:
        return err(`Không có công cụ ${name}`);
    }
  } catch (e) {
    console.error(`tool ${name} failed`, e);
    return err("Lỗi hệ thống khi truy cập lịch. Xin lỗi học viên và đề nghị thử lại sau hoặc nhắn trực tiếp HLV.");
  }
}

async function checkAvailability(
  p: z.infer<typeof CheckAvailability>,
  ctx: ToolContext,
  google: GoogleClient,
): Promise<ToolResult> {
  const first = vnToEpoch(p.date);
  if (first === null) return err("Ngày không hợp lệ, cần dạng YYYY-MM-DD.");
  const now = ctx.now();
  const earliest = now + MIN_BOOKING_NOTICE_HOURS * 3_600_000;
  const latest = now + MAX_BOOKING_DAYS_AHEAD * 86_400_000;
  const rangeEnd = first + p.days * 86_400_000;
  if (rangeEnd < now) return err("Ngày này đã qua.");
  if (first > latest) return err(`Chỉ nhận đặt lịch trong vòng ${MAX_BOOKING_DAYS_AHEAD} ngày tới.`);

  const busy = await google.busy(first, rangeEnd);
  const lines: string[] = [];
  for (let i = 0; i < p.days; i++) {
    const dayStart = first + i * 86_400_000;
    if (dayStart > latest) break;
    const date = epochToVnDate(dayStart);
    const hours = WORKING_HOURS[vnWeekday(dayStart)] ?? [];
    const slots = hours.length
      ? freeSlots(date, hours, p.duration_minutes, SLOT_STEP_MINUTES, busy, earliest)
      : [];
    const label = formatVn(dayStart).replace(/ 00:00$/, "");
    lines.push(
      hours.length === 0
        ? `${label}: HLV nghỉ`
        : slots.length === 0
          ? `${label}: hết giờ trống`
          : `${label}: ${slots.map(epochToVnTime).join(", ")}`,
    );
  }
  return {
    content:
      `Giờ bắt đầu còn trống cho buổi ${p.duration_minutes} phút (giờ VN, phải đặt trước ít nhất ${MIN_BOOKING_NOTICE_HOURS} tiếng):\n` +
      lines.join("\n"),
  };
}

async function createBooking(
  p: z.infer<typeof CreateBooking>,
  ctx: ToolContext,
  google: GoogleClient,
): Promise<ToolResult> {
  const start = vnDateTimeToEpoch(p.start);
  if (start === null) return err("Giờ bắt đầu không hợp lệ, cần dạng YYYY-MM-DDTHH:mm.");
  const end = start + p.duration_minutes * 60_000;
  const now = ctx.now();
  if (start < now + MIN_BOOKING_NOTICE_HOURS * 3_600_000)
    return err(`Phải đặt trước ít nhất ${MIN_BOOKING_NOTICE_HOURS} tiếng.`);
  if (start > now + MAX_BOOKING_DAYS_AHEAD * 86_400_000)
    return err(`Chỉ nhận đặt lịch trong vòng ${MAX_BOOKING_DAYS_AHEAD} ngày tới.`);
  if (!withinWorkingHours(start, p.duration_minutes, WORKING_HOURS))
    return err("Giờ này nằm ngoài giờ dạy của HLV. Hãy dùng check_availability để tìm giờ khác.");

  // Kiểm tra lại ngay trước khi ghi để tránh trùng lịch.
  const busy = await google.busy(start, end);
  if (busy.some((b) => b.start < end && start < b.end))
    return err("Giờ này vừa có người khác đặt hoặc HLV bận. Hãy kiểm tra lại giờ trống và đề xuất giờ khác.");

  const when = `${formatVn(start)}–${epochToVnTime(end)}`;
  const description = [
    `Học viên: ${p.student_name}`,
    `Zalo: ${ctx.zaloDisplayName} (${ctx.zaloUserId})`,
    p.phone ? `SĐT: ${p.phone}` : null,
    p.note ? `Ghi chú: ${p.note}` : null,
    "Đặt qua Zalo Bot",
  ]
    .filter(Boolean)
    .join("\n");
  const event = await google.createEvent({
    summary: `🎾 ${p.student_name} (${p.duration_minutes}')`,
    description,
    start: toRfc3339Vn(start),
    end: toRfc3339Vn(end),
    location: COACH.locations[0],
    privateProps: { zaloUserId: ctx.zaloUserId, source: "zalo-bot" },
  });

  await Promise.allSettled([
    google.appendRow([
      new Date(now).toISOString(),
      "ĐẶT",
      event.id,
      p.student_name,
      p.phone ?? "",
      ctx.zaloDisplayName,
      ctx.zaloUserId,
      toRfc3339Vn(start),
      p.duration_minutes,
      p.note ?? "",
    ]),
    ctx.notifyCoach(
      `📅 Lịch mới: ${p.student_name}\n${when}${p.phone ? `\nSĐT: ${p.phone}` : ""}${p.note ? `\nGhi chú: ${p.note}` : ""}`,
    ),
  ]);

  return { content: `Đã đặt thành công. Mã lịch: ${event.id}. Thời gian: ${when}.` };
}

async function listMyBookings(ctx: ToolContext, google: GoogleClient): Promise<ToolResult> {
  const events = await google.upcomingEventsFor(ctx.zaloUserId, ctx.now());
  if (events.length === 0) return { content: "Học viên chưa có buổi học nào sắp tới." };
  return {
    content: events
      .map((e) => {
        const s = Date.parse(e.start.dateTime ?? "");
        const en = Date.parse(e.end.dateTime ?? "");
        return `- Mã ${e.id}: ${formatVn(s)}–${epochToVnTime(en)} (${e.summary ?? ""})`;
      })
      .join("\n"),
  };
}

async function cancelBooking(
  p: z.infer<typeof CancelBooking>,
  ctx: ToolContext,
  google: GoogleClient,
): Promise<ToolResult> {
  let event;
  try {
    event = await google.getEvent(p.booking_id);
  } catch {
    return err("Không tìm thấy lịch này. Hãy dùng list_my_bookings để lấy đúng mã.");
  }
  if (event.status === "cancelled") return err("Lịch này đã được huỷ trước đó.");
  if (event.extendedProperties?.private?.zaloUserId !== ctx.zaloUserId)
    return err("Lịch này không phải do người đang chat đặt nên không thể huỷ.");
  const start = Date.parse(event.start.dateTime ?? "");
  if (start < ctx.now()) return err("Buổi học này đã diễn ra.");
  if (start - ctx.now() < MIN_CANCEL_NOTICE_HOURS * 3_600_000)
    return err(
      `Chỉ được tự huỷ trước giờ học ít nhất ${MIN_CANCEL_NOTICE_HOURS} tiếng. Hãy đề nghị học viên nhắn trực tiếp HLV.`,
    );

  await google.deleteEvent(p.booking_id);
  await Promise.allSettled([
    google.appendRow([
      new Date(ctx.now()).toISOString(),
      "HUỶ",
      p.booking_id,
      event.summary ?? "",
      "",
      ctx.zaloDisplayName,
      ctx.zaloUserId,
      event.start.dateTime ?? "",
      "",
      p.reason ?? "",
    ]),
    ctx.notifyCoach(
      `❌ Huỷ lịch: ${event.summary ?? ""}\n${formatVn(start)}${p.reason ? `\nLý do: ${p.reason}` : ""}`,
    ),
  ]);
  return { content: `Đã huỷ buổi học ${formatVn(start)}.` };
}
