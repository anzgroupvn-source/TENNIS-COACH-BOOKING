/**
 * Lưu dữ liệu trong Cloudflare KV (không cần Google):
 *   - Lịch 1 kèm 1 (chờ duyệt / đã xác nhận / từ chối / huỷ) và ghi danh lớp ghép: 1 tài liệu "store:v1".
 *   - Nhật ký hội thoại từng khách: "chatlog:<chatId>:<userId>" + mục lục "chatlog:index".
 *   - Zalo chat_id của HLV để nhận thông báo: "coach:chat_id".
 * Quy mô 1 HLV nên gói gọn trong vài tài liệu JSON là đủ.
 */
import type { Interval } from "./time";

export type BookingStatus = "pending" | "confirmed" | "rejected" | "cancelled";

export interface Booking {
  id: string;
  status: BookingStatus;
  start: number;
  end: number;
  durationMin: number;
  studentName: string;
  phone: string | null;
  note: string | null;
  price: string;
  zaloUserId: string;
  zaloName: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
  reason?: string | null;
  googleEventId?: string;
}

export interface GroupRegistration {
  id: string;
  status: "new" | "contacted";
  studentName: string;
  phone: string;
  preferredSchedule: string;
  note: string | null;
  zaloUserId: string;
  zaloName: string;
  chatId: string;
  createdAt: number;
}

interface StoreDoc {
  bookings: Booking[];
  groupRegs: GroupRegistration[];
}

export interface ChatLine {
  t: number;
  role: "user" | "bot";
  text: string;
}

export interface ChatLog {
  key: string;
  chatId: string;
  userId: string;
  name: string;
  chatType: string;
  lastAt: number;
  messages: ChatLine[];
}

export interface ChatIndexItem {
  key: string;
  name: string;
  lastAt: number;
  lastText: string;
  count: number;
}

const STORE_KEY = "store:v1";
const CHAT_INDEX_KEY = "chatlog:index";
const COACH_KEY = "coach:chat_id";
const KEEP_PAST_MS = 90 * 86_400_000;
const MAX_LOG_LINES = 300;
const MAX_INDEX = 500;
const LOG_TTL_SECONDS = 180 * 86_400;

export const ACTIVE: BookingStatus[] = ["pending", "confirmed"];

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8).toUpperCase();
}

export class Store {
  constructor(private kv: KVNamespace) {}

  async load(): Promise<StoreDoc> {
    const doc = await this.kv.get<StoreDoc>(STORE_KEY, "json");
    return { bookings: doc?.bookings ?? [], groupRegs: doc?.groupRegs ?? [] };
  }

  private async save(doc: StoreDoc, now: number) {
    doc.bookings = doc.bookings.filter((b) => b.end > now - KEEP_PAST_MS);
    doc.groupRegs = doc.groupRegs.filter((g) => g.createdAt > now - KEEP_PAST_MS);
    await this.kv.put(STORE_KEY, JSON.stringify(doc));
  }

  /** Đọc - sửa - ghi tài liệu chính. */
  async update<T>(now: number, fn: (doc: StoreDoc) => T): Promise<T> {
    const doc = await this.load();
    const result = fn(doc);
    await this.save(doc, now);
    return result;
  }

  /** Khoảng thời gian đã có người giữ chỗ hoặc đã xác nhận. */
  async busy(from: number, to: number): Promise<Interval[]> {
    const { bookings } = await this.load();
    return bookings
      .filter((b) => ACTIVE.includes(b.status) && b.start < to && b.end > from)
      .map((b) => ({ start: b.start, end: b.end }));
  }

  async getBooking(id: string): Promise<Booking | undefined> {
    return (await this.load()).bookings.find((b) => b.id === id);
  }

  // ---- HLV ----
  async coachChatId(): Promise<string | null> {
    return this.kv.get(COACH_KEY);
  }
  async setCoachChatId(chatId: string) {
    await this.kv.put(COACH_KEY, chatId);
  }

  // ---- Nhật ký hội thoại ----
  async logChat(
    info: { chatId: string; userId: string; name: string; chatType: string },
    lines: ChatLine[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const key = `chatlog:${info.chatId}:${info.userId}`;
    const log = (await this.kv.get<ChatLog>(key, "json")) ?? {
      key,
      chatId: info.chatId,
      userId: info.userId,
      name: info.name,
      chatType: info.chatType,
      lastAt: 0,
      messages: [],
    };
    log.name = info.name || log.name;
    log.messages.push(...lines);
    if (log.messages.length > MAX_LOG_LINES) log.messages = log.messages.slice(-MAX_LOG_LINES);
    const last = lines[lines.length - 1]!;
    log.lastAt = last.t;
    await this.kv.put(key, JSON.stringify(log), { expirationTtl: LOG_TTL_SECONDS });

    const index = (await this.kv.get<ChatIndexItem[]>(CHAT_INDEX_KEY, "json")) ?? [];
    const lastUser = [...log.messages].reverse().find((m) => m.role === "user");
    const item: ChatIndexItem = {
      key,
      name: log.name,
      lastAt: log.lastAt,
      lastText: (lastUser ?? last).text.slice(0, 140),
      count: log.messages.length,
    };
    const next = [item, ...index.filter((i) => i.key !== key)].slice(0, MAX_INDEX);
    await this.kv.put(CHAT_INDEX_KEY, JSON.stringify(next));
  }

  async chatIndex(): Promise<ChatIndexItem[]> {
    return (await this.kv.get<ChatIndexItem[]>(CHAT_INDEX_KEY, "json")) ?? [];
  }

  async chatLog(key: string): Promise<ChatLog | null> {
    if (!key.startsWith("chatlog:") || key === CHAT_INDEX_KEY) return null;
    return this.kv.get<ChatLog>(key, "json");
  }
}
