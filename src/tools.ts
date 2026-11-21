/**
 * Các công cụ Claude được dùng để báo giá, đặt lịch và ghi danh. Mọi kiểm tra quan trọng
 * (giờ dạy, trùng lịch, quyền huỷ) đều làm trong code, không giao cho model.
 * Lịch lưu trong Cloudflare KV (Store); lịch Google (nếu có cấu hình) chỉ dùng thêm để tránh giờ bận.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  LESSON_DURATIONS,
  DEFAULT_DURATION,
  MAX_BOOKING_DAYS_AHEAD,
  MIN_BOOKING_NOTICE_HOURS,
  MIN_CANCEL_NOTICE_HOURS,
  SLOT_STEP_MINUTES,
  WORKING_HOURS,
} from "./config";
import type { GoogleClient } from "./google";
import { describeQuote, quotePrivate } from "./pricing";
import { ACTIVE, newId, type Store } from "./store";
import {
  epochToVnDate,
  epochToVnTime,
  formatVn,
  freeSlots,
  overlaps,
  vnDateTimeToEpoch,
  vnToEpoch,
  vnWeekday,
  withinWorkingHours,
  type Interval,
} from "./time";

export interface ToolContext {
  zaloUserId: string;
  zaloDisplayName: string;
  chatId: string;
  store: Store;
  google: GoogleClient | null;
  notifyCoach: (text: string) => Promise<void>;
  /** Link trang quản lý để gửi kèm thông báo cho HLV. */
  adminUrl: string | null;
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
const QuotePrice = z.object({
  start: z.string(),
  duration_minutes: durationSchema,
});
const RegisterGroupClass = z.object({
  student_name: z.string().min(1).max(100),
  phone: z.string().min(6).max(30),
  preferred_schedule: z.string().max(300),
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
      "Gửi YÊU CẦU đặt một buổi học 1 kèm 1: hệ thống giữ chỗ và HLV sẽ xác nhận/từ chối, học viên nhận tin báo qua Zalo. " +
      "CHỈ gọi sau khi học viên đã xác nhận rõ ràng ngày, giờ, thời lượng và tên. Hệ thống tự kiểm tra giờ trống; nếu trùng sẽ báo lỗi.",
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
    name: "quote_price",
    description:
      "Tính chính xác tiền một buổi học 1 kèm 1 (học phí + phí sân theo giờ và ngày). " +
      "Luôn dùng công cụ này khi báo giá buổi 1 kèm 1 cụ thể, không tự nhẩm.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        start: { type: "string", description: "Giờ bắt đầu, dạng YYYY-MM-DDTHH:mm theo giờ Việt Nam." },
        duration_minutes: { type: "integer", description: `Thời lượng (phút): ${LESSON_DURATIONS.join(", ")}.` },
      },
      required: ["start", "duration_minutes"],
    },
  },
  {
    name: "register_group_class",
    description:
      "Ghi danh học viên vào LỚP GHÉP (HLV sẽ tự xếp lớp và liên hệ lại). " +
      "Chỉ gọi khi đã có tên, số điện thoại và khung giờ/ngày mong muốn, và học viên đã xác nhận.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        student_name: { type: "string", description: "Tên học viên." },
        phone: { type: "string", description: "Số điện thoại để HLV liên hệ xếp lớp." },
        preferred_schedule: {
          type: "string",
          description: "Ngày/khung giờ mong muốn trong khoảng 06:00–17:00, vd 'sáng T2-T4-T6 khoảng 7h'.",
        },
        note: { type: ["string", "null"], description: "Trình độ, mục tiêu, số người đi cùng... hoặc null." },
      },
      required: ["student_name", "phone", "preferred_schedule", "note"],
    },
  },
  {
    name: "list_my_bookings",
    description:
      "Liệt kê các buổi học sắp tới mà chính người đang chat đã đặt, kèm trạng thái (chờ HLV xác nhận / đã xác nhận) và mã lịch để huỷ.",
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
  try {
    switch (name) {
      case "quote_price": {
        const p = QuotePrice.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        const start = vnDateTimeToEpoch(p.data.start);
        if (start === null) return err("Giờ bắt đầu không hợp lệ, cần dạng YYYY-MM-DDTHH:mm.");
        return {
          content: `Buổi 1 kèm 1 ${formatVn(start)}, ${p.data.duration_minutes} phút: ${describeQuote(quotePrivate(start, p.data.duration_minutes))}`,
        };
      }
      case "check_availability": {
        const p = CheckAvailability.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await checkAvailability(p.data, ctx);
      }
      case "create_booking": {
        const p = CreateBooking.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await createBooking(p.data, ctx);
      }
      case "list_my_bookings":
        return await listMyBookings(ctx);
      case "cancel_booking": {
        const p = CancelBooking.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await cancelBooking(p.data, ctx);
      }
      case "register_group_class": {
        const p = RegisterGroupClass.safeParse(input);
        if (!p.success) return err(`Tham số không hợp lệ: ${p.error.message}`);
        return await registerGroupClass(p.data, ctx);
      }
      default:
        return err(`Không có công cụ ${name}`);
    }
  } catch (e) {
    console.error(`tool ${name} failed`, e);
    return err("Lỗi hệ thống khi xử lý lịch. Xin lỗi học viên và đề nghị thử lại sau hoặc nhắn trực tiếp HLV.");
  }
}

/** Giờ bận = lịch đang giữ chỗ/đã xác nhận + (nếu có) lịch Google của HLV. */
async function busyTimes(ctx: ToolContext, from: number, to: number): Promise<Interval[]> {
  const own = await ctx.store.busy(from, to);
  if (!ctx.google) return own;
  try {
    return [...own, ...(await ctx.google.busy(from, to))];
  } catch (e) {
    console.error("google busy failed", e);
    return own;
  }
}

const adminLink = (ctx: ToolContext) => (ctx.adminUrl ? `\nXem & duyệt: ${ctx.adminUrl}` : "");

async function checkAvailability(p: z.infer<typeof CheckAvailability>, ctx: ToolContext): Promise<ToolResult> {
  const first = vnToEpoch(p.date);
  if (first === null) return err("Ngày không hợp lệ, cần dạng YYYY-MM-DD.");
  const now = ctx.now();
  const earliest = now + MIN_BOOKING_NOTICE_HOURS * 3_600_000;
  const latest = now + MAX_BOOKING_DAYS_AHEAD * 86_400_000;
  const rangeEnd = first + p.days * 86_400_000;
  if (rangeEnd < now) return err("Ngày này đã qua.");
  if (first > latest) return err(`Chỉ nhận đặt lịch trong vòng ${MAX_BOOKING_DAYS_AHEAD} ngày tới.`);

  const busy = await busyTimes(ctx, first, rangeEnd);
  const lines: string[] = [];
  for (let i = 0; i < p.days; i++) {
    const dayStart = first + i * 86_400_000;
    if (dayStart > latest) break;
    const date = epochToVnDate(dayStart);
    const hours = WORKING_HOURS[vnWeekday(dayStart)] ?? [];
    const slots = hours.length ? freeSlots(date, hours, p.duration_minutes, SLOT_STEP_MINUTES, busy, earliest) : [];
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
      `Giờ bắt đầu còn trống cho buổi ${p.duration_minutes} phút (giờ VN, phải đặt trước ít nhất ${MIN_BOOKING_NOTICE_HOURS} tiếng). ` +
      `Lưu ý: HLV vẫn cần xác nhận vì có thể trùng lớp ghép hoặc việc riêng.\n` +
      lines.join("\n"),
  };
}

async function createBooking(p: z.infer<typeof CreateBooking>, ctx: ToolContext): Promise<ToolResult> {
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

  const googleBusy = ctx.google ? await busyTimes(ctx, start, end) : [];
  const price = describeQuote(quotePrivate(start, p.duration_minutes));
  const slot = { start, end };

  const booking = await ctx.store.update(now, (doc) => {
    const clash =
      googleBusy.some((b) => overlaps(slot, b)) ||
      doc.bookings.some((b) => ACTIVE.includes(b.status) && overlaps(slot, b));
    if (clash) return null;
    const b = {
      id: newId(),
      status: "pending" as const,
      start,
      end,
      durationMin: p.duration_minutes,
      studentName: p.student_name,
      phone: p.phone,
      note: p.note,
      price,
      zaloUserId: ctx.zaloUserId,
      zaloName: ctx.zaloDisplayName,
      chatId: ctx.chatId,
      createdAt: now,
      updatedAt: now,
    };
    doc.bookings.push(b);
    return b;
  });
  if (!booking)
    return err("Giờ này vừa có người khác giữ chỗ hoặc HLV bận. Hãy kiểm tra lại giờ trống và đề xuất giờ khác.");

  const when = `${formatVn(start)}–${epochToVnTime(end)}`;
  await Promise.allSettled([
    ctx.notifyCoach(
      `🔔 YÊU CẦU ĐẶT LỊCH 1 KÈM 1 (chờ anh duyệt)\n${p.student_name}${p.phone ? ` – ${p.phone}` : ""}\n${when}\n${price}` +
        `${p.note ? `\nGhi chú: ${p.note}` : ""}\nZalo: ${ctx.zaloDisplayName}${adminLink(ctx)}`,
    ),
    ctx.google?.appendRow([
      new Date(now).toISOString(), "YÊU CẦU", booking.id, p.student_name, p.phone ?? "",
      ctx.zaloDisplayName, ctx.zaloUserId, when, p.duration_minutes, p.note ?? "",
    ]),
  ]);

  return {
    content:
      `Đã gửi yêu cầu và GIỮ CHỖ ${when} (mã ${booking.id}). Trạng thái: CHỜ HLV XÁC NHẬN — chưa phải lịch chốt. ` +
      `HLV xác nhận xong, hệ thống sẽ tự nhắn cho học viên qua Zalo. ${price}.`,
  };
}

const STATUS_VI: Record<string, string> = {
  pending: "chờ HLV xác nhận",
  confirmed: "đã xác nhận",
  rejected: "HLV từ chối",
  cancelled: "đã huỷ",
};

async function listMyBookings(ctx: ToolContext): Promise<ToolResult> {
  const now = ctx.now();
  const { bookings } = await ctx.store.load();
  const mine = bookings
    .filter((b) => b.zaloUserId === ctx.zaloUserId && b.end > now)
    .sort((a, b) => a.start - b.start);
  if (mine.length === 0) return { content: "Học viên chưa có buổi học nào sắp tới." };
  return {
    content: mine
      .map((b) => `- Mã ${b.id}: ${formatVn(b.start)}–${epochToVnTime(b.end)}, ${b.studentName} — ${STATUS_VI[b.status]}`)
      .join("\n"),
  };
}

async function cancelBooking(p: z.infer<typeof CancelBooking>, ctx: ToolContext): Promise<ToolResult> {
  const now = ctx.now();
  const id = p.booking_id.trim().toUpperCase();
  const outcome = await ctx.store.update(now, (doc) => {
    const b = doc.bookings.find((x) => x.id === id);
    if (!b || b.zaloUserId !== ctx.zaloUserId) return { error: "Không tìm thấy lịch này của người đang chat. Hãy dùng list_my_bookings để lấy đúng mã." };
    if (!ACTIVE.includes(b.status)) return { error: `Lịch này đang ở trạng thái "${STATUS_VI[b.status]}", không cần huỷ.` };
    if (b.start < now) return { error: "Buổi học này đã diễn ra." };
    if (b.status === "confirmed" && b.start - now < MIN_CANCEL_NOTICE_HOURS * 3_600_000)
      return { error: `Lịch đã xác nhận chỉ được tự huỷ trước giờ học ít nhất ${MIN_CANCEL_NOTICE_HOURS} tiếng. Hãy đề nghị học viên nhắn trực tiếp HLV.` };
    const wasConfirmed = b.status === "confirmed";
    b.status = "cancelled";
    b.reason = p.reason;
    b.updatedAt = now;
    return { booking: { ...b }, wasConfirmed };
  });
  if ("error" in outcome) return err(outcome.error!);
  const b = outcome.booking;
  if (b.googleEventId && ctx.google) await ctx.google.deleteEvent(b.googleEventId).catch(() => {});
  await ctx
    .notifyCoach(
      `❌ Học viên huỷ lịch${outcome.wasConfirmed ? "" : " (đang chờ duyệt)"}: ${b.studentName}\n${formatVn(b.start)}–${epochToVnTime(b.end)}` +
        `${p.reason ? `\nLý do: ${p.reason}` : ""}`,
    )
    .catch(() => {});
  return { content: `Đã huỷ buổi học ${formatVn(b.start)} (mã ${b.id}).` };
}

async function registerGroupClass(p: z.infer<typeof RegisterGroupClass>, ctx: ToolContext): Promise<ToolResult> {
  const now = ctx.now();
  const reg = await ctx.store.update(now, (doc) => {
    const r = {
      id: newId(),
      status: "new" as const,
      studentName: p.student_name,
      phone: p.phone,
      preferredSchedule: p.preferred_schedule,
      note: p.note,
      zaloUserId: ctx.zaloUserId,
      zaloName: ctx.zaloDisplayName,
      chatId: ctx.chatId,
      createdAt: now,
    };
    doc.groupRegs.push(r);
    return r;
  });
  await Promise.allSettled([
    ctx.notifyCoach(
      `👥 GHI DANH LỚP GHÉP: ${p.student_name}\nSĐT: ${p.phone}\nMong muốn: ${p.preferred_schedule}` +
        `${p.note ? `\nGhi chú: ${p.note}` : ""}\nZalo: ${ctx.zaloDisplayName}${adminLink(ctx)}`,
    ),
    ctx.google?.appendRow([
      new Date(now).toISOString(), "GHI DANH LỚP GHÉP", reg.id, p.student_name, p.phone,
      ctx.zaloDisplayName, ctx.zaloUserId, p.preferred_schedule, "", p.note ?? "",
    ]),
  ]);
  return { content: `Đã ghi danh lớp ghép (mã ${reg.id}). HLV sẽ xếp lớp và liên hệ lại học viên qua số điện thoại/Zalo.` };
}
