import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { freeSlots, vnToEpoch, vnDateTimeToEpoch, formatVn, withinWorkingHours, toRfc3339Vn } from "../src/time";
import { splitText } from "../src/zalo";
import { quotePrivate, describeQuote } from "../src/pricing";
import { SYSTEM_PROMPT } from "../src/claude";
import { WORKING_HOURS } from "../src/config";
import { handleUpdate, webhookSecret, type Env } from "../src/index";
import worker from "../src/index";

// Thứ 7, 21/11/2026 08:00 giờ VN
const NOW = vnToEpoch("2026-11-21", "08:00")!;

describe("time helpers", () => {
  it("chuyển đổi giờ VN", () => {
    expect(new Date(vnToEpoch("2026-11-24", "17:30")!).toISOString()).toBe("2026-11-24T10:30:00.000Z");
    expect(vnToEpoch("2026-02-31")).toBeNull();
    expect(vnDateTimeToEpoch("2026-11-24T17:30")).toBe(vnToEpoch("2026-11-24", "17:30"));
    expect(formatVn(vnToEpoch("2026-11-24", "17:30")!)).toBe("Thứ 3, 24/11/2026 17:30");
    expect(toRfc3339Vn(vnToEpoch("2026-11-24", "06:05")!)).toBe("2026-11-24T06:05:00+07:00");
  });

  it("tính giờ trống, bỏ giờ bận và giờ quá sớm", () => {
    const busy = [{ start: vnToEpoch("2026-11-24", "17:00")!, end: vnToEpoch("2026-11-24", "18:00")! }];
    const slots = freeSlots("2026-11-24", [["16:00", "19:00"]], 60, 30, busy, 0).map((s) => formatVn(s).slice(-5));
    expect(slots).toEqual(["16:00", "18:00"]);
    const late = freeSlots("2026-11-24", [["16:00", "19:00"]], 60, 30, [], vnToEpoch("2026-11-24", "17:10")!);
    expect(late.map((s) => formatVn(s).slice(-5))).toEqual(["17:30", "18:00"]);
  });

  it("kiểm tra giờ dạy", () => {
    expect(withinWorkingHours(vnToEpoch("2026-11-24", "16:00")!, 90, WORKING_HOURS)).toBe(true);
    expect(withinWorkingHours(vnToEpoch("2026-11-24", "20:30")!, 60, WORKING_HOURS)).toBe(false);
  });

  it("tính tiền 1 kèm 1 theo bảng phí sân", () => {
    // Thứ 3 (24/11/2026)
    expect(quotePrivate(vnToEpoch("2026-11-24", "07:00")!, 60).total).toBe(400_000);
    expect(quotePrivate(vnToEpoch("2026-11-24", "18:00")!, 60).total).toBe(500_000);
    // 16:00–18:00 thứ 3: 600k + 100k + 200k
    const cross = quotePrivate(vnToEpoch("2026-11-24", "16:00")!, 120);
    expect(cross).toMatchObject({ tuition: 600_000, court: 300_000, total: 900_000 });
    expect(describeQuote(cross)).toContain("tổng 900k");
    // Thứ 7 (28/11/2026), Chủ nhật (29/11/2026)
    expect(quotePrivate(vnToEpoch("2026-11-28", "08:00")!, 60).total).toBe(420_000);
    expect(quotePrivate(vnToEpoch("2026-11-29", "19:00")!, 120).total).toBe(1_000_000);
  });

  it("system prompt có đủ bảng giá", () => {
    for (const t of ["200k/buổi", "300k/giờ", "100k/giờ", "120k/giờ", "200k/giờ", "06:00–21:00", "06:00–17:00"]) {
      expect(SYSTEM_PROMPT).toContain(t);
    }
  });

  it("chia tin nhắn dài", () => {
    const parts = splitText(("dòng ".repeat(50) + "\n").repeat(20), 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, "")).toBe(("dòng ".repeat(50)).repeat(20).replace(/\s+/g, ""));
  });
});

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string, type?: string) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function makeEnv(kv: MemoryKV): Env {
  return {
    ZALO_BOT_TOKEN: "123:abc",
    ZALO_WEBHOOK_SECRET: "webhook-secret-123",
    ADMIN_KEY: "admin",
    ANTHROPIC_API_KEY: "test",
    CLAUDE_MODEL: "claude-opus-5-5",
    CLAUDE_EFFORT: "medium",
    BOT_KV: kv as unknown as KVNamespace,
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_CALENDAR_ID: "coach@example.com",
    GOOGLE_SHEET_ID: "sheet1",
    GOOGLE_SHEET_TAB: "Bookings",
    COACH_ZALO_CHAT_ID: "coach-chat",
  };
}

const textUpdate = (text: string, id = "m1") => ({
  event_name: "message.text.received",
  message: {
    message_id: id,
    date: NOW,
    message_type: "CHAT_TEXT",
    from: { id: "user-1", display_name: "Lan", is_bot: false },
    chat: { id: "user-1", chat_type: "PRIVATE" },
    text,
  },
});

/** Giả lập fetch cho Zalo + Google. */
function mockFetch() {
  const zaloSent: Array<{ method: string; body: any }> = [];
  const googleCalls: Array<{ url: string; method: string; body: any }> = [];
  const events: any[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body;
    if (url.startsWith("https://bot-api.zaloplatforms.com/")) {
      zaloSent.push({ method: url.split("/").pop()!, body });
      return Response.json({ ok: true, result: {} });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    googleCalls.push({ url, method: init?.method ?? "GET", body });
    if (url.includes("/freeBusy")) {
      return Response.json({
        calendars: {
          "coach@example.com": {
            busy: events.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })),
          },
        },
      });
    }
    if (url.endsWith("/events") && init?.method === "POST") {
      const ev = { id: `ev${events.length + 1}`, ...body };
      events.push(ev);
      return Response.json(ev);
    }
    if (url.includes("sheets.googleapis.com")) return Response.json({});
    return new Response("not found", { status: 404 });
  });
  return { fetchMock, zaloSent, googleCalls, events };
}

/** Anthropic giả: trả lời theo kịch bản. */
function fakeAnthropic(script: Array<(params: any) => Partial<Anthropic.Beta.BetaMessage>>) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        create: vi.fn(async (params: any) => {
          calls.push(structuredClone(params));
          const step = script[calls.length - 1];
          if (!step) throw new Error("no more scripted responses");
          return { stop_reason: "end_turn", content: [], ...step(params) };
        }),
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("webhook flow", () => {
  let kv: MemoryKV;
  let env: Env;
  let f: ReturnType<typeof mockFetch>;

  beforeEach(async () => {
    kv = new MemoryKV();
    env = makeEnv(kv);
    f = mockFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    // Khoá giả để ký JWT trong test
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "bot@x.iam.gserviceaccount.com", private_key: pem });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("từ chối webhook sai secret", async () => {
    const req = new Request("https://bot.example/webhook", {
      method: "POST",
      headers: { "X-Bot-Api-Secret-Token": "wrong" },
      body: JSON.stringify(textUpdate("hi")),
    });
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(res.status).toBe(403);
  });

  it("secret webhook tự sinh từ token khi không đặt ZALO_WEBHOOK_SECRET", async () => {
    delete env.ZALO_WEBHOOK_SECRET;
    const secret = await webhookSecret(env);
    expect(secret).toHaveLength(48);
    const exec = { waitUntil() {}, passThroughOnException() {} } as any;
    const ok = await worker.fetch(
      new Request("https://bot.example/webhook", { method: "POST", headers: { "X-Bot-Api-Secret-Token": secret }, body: JSON.stringify(textUpdate("hi")) }),
      env,
      exec,
    );
    expect(ok.status).toBe(200);
    const bad = await worker.fetch(
      new Request("https://bot.example/webhook", { method: "POST", headers: { "X-Bot-Api-Secret-Token": "x" }, body: "{}" }),
      env,
      exec,
    );
    expect(bad.status).toBe(403);
  });

  it("đặt lịch end-to-end: xem giờ trống -> đặt -> báo HLV -> lưu lịch sử", async () => {
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig1" } as any,
          { type: "tool_use", id: "t1", name: "check_availability", input: { date: "2026-11-24", days: 1, duration_minutes: 60 } } as any,
        ],
      }),
      () => ({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t2", name: "create_booking", input: { start: "2026-11-24T17:00", duration_minutes: 60, student_name: "Lan", phone: "0901234567", note: "mới học" } } as any,
        ],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Đã đặt lịch **17:00 thứ 3** cho chị Lan ạ!" } as any] }),
    ]);

    await handleUpdate(textUpdate("Đặt giúp chị 17h thứ 3 nhé, tên Lan"), env, { anthropic: client, now: () => NOW });

    // Tool result của check_availability phải có 17:00
    const toolResult1 = calls[1].messages.at(-1).content[0];
    expect(toolResult1.type).toBe("tool_result");
    expect(toolResult1.content).toContain("17:00");
    expect(toolResult1.content).not.toContain("21:00");

    // Sự kiện được tạo đúng giờ
    expect(f.events).toHaveLength(1);
    expect(f.events[0].start.dateTime).toBe("2026-11-24T17:00:00+07:00");
    expect(f.events[0].extendedProperties.private.zaloUserId).toBe("user-1");

    // Gửi cho học viên + báo HLV
    const texts = f.zaloSent.filter((s) => s.method === "sendMessage");
    expect(texts.some((s) => s.body.chat_id === "coach-chat" && s.body.text.includes("Lan"))).toBe(true);
    expect(texts.some((s) => s.body.chat_id === "user-1" && s.body.text.includes("Đã đặt lịch"))).toBe(true);

    // Yêu cầu gửi Claude đúng cấu hình
    expect(calls[0].model).toBe("claude-opus-5-5");
    expect(calls[0].fallbacks).toBe("default");
    expect(calls[0].thinking.block_binding.prefix_mismatch_behavior).toBe("drop_block");

    // Lịch sử chỉ nối thêm: lượt sau bắt đầu bằng đúng các tin cũ
    const stored = JSON.parse(kv.store.get("hist:user-1:user-1")!);
    expect(stored.messages).toHaveLength(6);
    const { client: c2, calls: calls2 } = fakeAnthropic([
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Dạ vâng" } as any] }),
    ]);
    await handleUpdate(textUpdate("cảm ơn em", "m2"), env, { anthropic: c2, now: () => NOW + 60_000 });
    expect(calls2[0].messages.slice(0, 6)).toEqual(stored.messages);
    expect(calls2[0].messages).toHaveLength(7);
  });

  it("không cho đặt trùng giờ đã bận", async () => {
    f.events.push({ id: "x", start: { dateTime: "2026-11-24T17:00:00+07:00" }, end: { dateTime: "2026-11-24T18:00:00+07:00" } });
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "create_booking", input: { start: "2026-11-24T17:30", duration_minutes: 60, student_name: "Lan", phone: null, note: null } } as any],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Giờ đó đã kín ạ" } as any] }),
    ]);
    await handleUpdate(textUpdate("đặt 17h30 thứ 3"), env, { anthropic: client, now: () => NOW });
    const result = calls[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(f.events).toHaveLength(1);
  });

  it("ghi danh lớp ghép: ghi Sheet + báo HLV", async () => {
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "register_group_class", input: { student_name: "Minh", phone: "0909000111", preferred_schedule: "sáng T2-T4-T6", note: null } } as any],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Em đã ghi danh ạ" } as any] }),
    ]);
    await handleUpdate(textUpdate("cho anh đăng ký lớp ghép"), env, { anthropic: client, now: () => NOW });
    expect(calls[1].messages.at(-1).content[0].is_error).toBeFalsy();
    expect(f.googleCalls.some((c) => c.url.includes("sheets") && c.body.values[0][1] === "GHI DANH LỚP GHÉP")).toBe(true);
    expect(f.zaloSent.some((s) => s.body?.chat_id === "coach-chat" && s.body.text.includes("Minh"))).toBe(true);
  });

  it("báo giá chạy được khi chưa nối Google", async () => {
    env.GOOGLE_SHEET_ID = "REPLACE_WITH_SHEET_ID";
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "quote_price", input: { start: "2026-11-28T18:00", duration_minutes: 60 } } as any],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "500k ạ" } as any] }),
    ]);
    await handleUpdate(textUpdate("tối thứ 7 6h học 1 kèm 1 bao nhiêu"), env, { anthropic: client, now: () => NOW });
    expect(calls[1].messages.at(-1).content[0].content).toContain("tổng 500k");
  });

  it("bỏ qua tin nhắn trùng message_id và trả lời lệnh /id", async () => {
    await handleUpdate(textUpdate("/id", "dup"), env);
    await handleUpdate(textUpdate("/id", "dup"), env);
    const texts = f.zaloSent.filter((s) => s.method === "sendMessage");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body.text).toContain("user-1");
  });
});
