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
    GOOGLE_CALENDAR_ID: "REPLACE_WITH_COACH_CALENDAR_ID",
    GOOGLE_SHEET_ID: "REPLACE_WITH_SHEET_ID",
    GOOGLE_SHEET_TAB: "Bookings",
    COACH_ZALO_CHAT_ID: "",
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
  let serviceAccount: string;
  const exec = { waitUntil() {}, passThroughOnException() {} } as any;
  const sent = () => f.zaloSent.filter((x) => x.method === "sendMessage").map((x) => x.body as { chat_id: string; text: string });

  async function adminCookie() {
    const res = await worker.fetch(new Request("https://bot.example/admin?key=admin"), env, exec);
    expect(res.status).toBe(303);
    return res.headers.get("Set-Cookie")!.split(";")[0]!;
  }
  async function adminPost(path: string, fields: Record<string, string>, cookie: string) {
    const body = new URLSearchParams(fields);
    return worker.fetch(
      new Request(`https://bot.example${path}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      exec,
    );
  }
  async function registerCoach() {
    await handleUpdate(
      { ...textUpdate("/hlv admin", "coach-msg"), message: { ...textUpdate("").message, message_id: "coach-msg", text: "/hlv admin", from: { id: "coach", display_name: "Đức", is_bot: false }, chat: { id: "coach-chat", chat_type: "PRIVATE" } } },
      env,
      { origin: "https://bot.example" },
    );
  }

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
    serviceAccount = JSON.stringify({ client_email: "bot@x.iam.gserviceaccount.com", private_key: pem });
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

  it("HLV đăng ký nhận thông báo bằng /hlv; sai mã bị từ chối; không ghi log", async () => {
    await handleUpdate(
      { ...textUpdate(""), message: { ...textUpdate("").message, message_id: "x1", text: "/hlv sai", chat: { id: "c9", chat_type: "PRIVATE" } } },
      env,
    );
    expect(kv.store.get("coach:chat_id")).toBeUndefined();
    await registerCoach();
    expect(kv.store.get("coach:chat_id")).toBe("coach-chat");
    expect(sent().at(-1)!.text).toContain("https://bot.example/admin");
    expect([...kv.store.keys()].some((k) => k.startsWith("chatlog:coach-chat"))).toBe(false);
  });

  it("đặt lịch: giữ chỗ chờ duyệt -> báo HLV -> HLV xác nhận trên web -> nhắn học viên", async () => {
    await registerCoach();
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig1" } as any,
          { type: "tool_use", id: "t1", name: "check_availability", input: { date: "2026-11-25", days: 1, duration_minutes: 60 } } as any,
        ],
      }),
      () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "create_booking", input: { start: "2026-11-25T07:00", duration_minutes: 60, student_name: "Lan", phone: "0901234567", note: "mới học" } } as any],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Em đã giữ chỗ 7:00 thứ 4, chờ HLV xác nhận ạ!" } as any] }),
    ]);
    await handleUpdate(textUpdate("1 giờ 7:00-8:00 sáng ngày 25, tên Lan"), env, { anthropic: client, now: () => NOW, origin: "https://bot.example" });

    expect(calls[1].messages.at(-1).content[0].content).toContain("07:00");
    const created = calls[2].messages.at(-1).content[0];
    expect(created.is_error).toBeFalsy();
    expect(created.content).toContain("CHỜ HLV XÁC NHẬN");

    const doc = JSON.parse(kv.store.get("store:v1")!);
    expect(doc.bookings).toHaveLength(1);
    const b = doc.bookings[0];
    expect(b).toMatchObject({ status: "pending", studentName: "Lan", chatId: "user-1" });
    expect(b.price).toContain("tổng 400k");

    const coachMsg = sent().find((m) => m.chat_id === "coach-chat" && m.text.includes("YÊU CẦU"))!;
    expect(coachMsg.text).toContain("Lan");
    expect(coachMsg.text).toContain("https://bot.example/admin");

    // Khung giờ đang giữ chỗ không còn trống cho người khác
    const { client: c2, calls: calls2 } = fakeAnthropic([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "a", name: "create_booking", input: { start: "2026-11-25T07:30", duration_minutes: 60, student_name: "Hùng", phone: null, note: null } } as any] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Giờ đó kín rồi ạ" } as any] }),
    ]);
    await handleUpdate(
      { ...textUpdate(""), message: { ...textUpdate("").message, message_id: "m-hung", text: "đặt 7h30", from: { id: "user-2", display_name: "Hùng", is_bot: false }, chat: { id: "user-2", chat_type: "PRIVATE" } } },
      env,
      { anthropic: c2, now: () => NOW },
    );
    expect(calls2[1].messages.at(-1).content[0].is_error).toBe(true);

    // HLV xác nhận trên trang quản lý
    const cookie = await adminCookie();
    const page = await (await worker.fetch(new Request("https://bot.example/admin", { headers: { Cookie: cookie } }), env, exec)).text();
    expect(page).toContain("Chờ duyệt (1)");
    expect(page).toContain("0901234567");
    const res = await adminPost("/admin/booking", { id: b.id, action: "confirm", reason: "Mang giày tennis nhé" }, cookie);
    expect(res.status).toBe(303);
    expect(JSON.parse(kv.store.get("store:v1")!).bookings[0].status).toBe("confirmed");
    const toStudent = sent().filter((m) => m.chat_id === "user-1").at(-1)!;
    expect(toStudent.text).toContain("XÁC NHẬN");
    expect(toStudent.text).toContain("Mang giày tennis nhé");

    // Xác nhận lần 2 không gửi trùng
    const before = sent().length;
    await adminPost("/admin/booking", { id: b.id, action: "confirm" }, cookie);
    expect(sent().length).toBe(before);

    // Học viên xem lịch thấy "đã xác nhận"
    const { client: c3, calls: calls3 } = fakeAnthropic([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "l", name: "list_my_bookings", input: {} } as any] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as any] }),
    ]);
    await handleUpdate(textUpdate("lịch của chị sao rồi", "m3"), env, { anthropic: c3, now: () => NOW + 60_000 });
    expect(calls3[1].messages.at(-1).content[0].content).toContain("đã xác nhận");
  });

  it("HLV từ chối -> giải phóng giờ và nhắn học viên", async () => {
    const { client } = fakeAnthropic([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "create_booking", input: { start: "2026-11-25T18:00", duration_minutes: 120, student_name: "Lan", phone: null, note: null } } as any] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as any] }),
    ]);
    await handleUpdate(textUpdate("đặt"), env, { anthropic: client, now: () => NOW });
    const b = JSON.parse(kv.store.get("store:v1")!).bookings[0];
    expect(b.price).toContain("tổng 1.000k");
    const cookie = await adminCookie();
    await adminPost("/admin/booking", { id: b.id, action: "reject", reason: "" }, cookie);
    expect(JSON.parse(kv.store.get("store:v1")!).bookings[0].status).toBe("rejected");
    expect(sent().filter((m) => m.chat_id === "user-1").at(-1)!.text).toContain("không nhận được");
  });

  it("ghi danh lớp ghép: lưu, báo HLV, hiện trên trang quản lý", async () => {
    await registerCoach();
    const { client, calls } = fakeAnthropic([
      () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "register_group_class", input: { student_name: "Minh <b>", phone: "0909000111", preferred_schedule: "sáng T2-T4-T6", note: null } } as any],
      }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Em đã ghi danh ạ" } as any] }),
    ]);
    await handleUpdate(textUpdate("cho anh đăng ký lớp ghép"), env, { anthropic: client, now: () => NOW });
    expect(calls[1].messages.at(-1).content[0].is_error).toBeFalsy();
    expect(sent().some((m) => m.chat_id === "coach-chat" && m.text.includes("LỚP GHÉP"))).toBe(true);
    const cookie = await adminCookie();
    const html = await (await worker.fetch(new Request("https://bot.example/admin", { headers: { Cookie: cookie } }), env, exec)).text();
    expect(html).toContain("Minh &lt;b&gt;");
    expect(html).not.toContain("Minh <b>");
  });

  it("trang quản lý: chưa đăng nhập không xem được; xem được nhật ký tin nhắn", async () => {
    const { client } = fakeAnthropic([() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Dạ em chào chị Lan 🎾" } as any] })]);
    await handleUpdate(textUpdate("chào em, học phí bao nhiêu?"), env, { anthropic: client, now: () => NOW });

    const anon = await (await worker.fetch(new Request("https://bot.example/admin/chats"), env, exec));
    expect(anon.status).toBe(403);
    const loginPage = await (await worker.fetch(new Request("https://bot.example/admin"), env, exec)).text();
    expect(loginPage).toContain("Đăng nhập");
    expect(loginPage).not.toContain("Lan");
    const bad = await worker.fetch(new Request("https://bot.example/admin", { headers: { Cookie: "coach_admin=" + "0".repeat(64) } }), env, exec);
    expect(await bad.text()).toContain("Đăng nhập");

    const cookie = await adminCookie();
    const list = await (await worker.fetch(new Request("https://bot.example/admin/chats", { headers: { Cookie: cookie } }), env, exec)).text();
    expect(list).toContain("Lan");
    expect(list).toContain("học phí bao nhiêu");
    const detail = await (
      await worker.fetch(new Request(`https://bot.example/admin/chat?k=${encodeURIComponent("chatlog:user-1:user-1")}`, { headers: { Cookie: cookie } }), env, exec)
    ).text();
    expect(detail).toContain("Dạ em chào chị Lan");
  });

  it("báo giá chạy được", async () => {
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

  it("có Google Calendar: giờ bận trên Google chặn giữ chỗ; xác nhận thì tạo sự kiện", async () => {
    env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
    env.GOOGLE_CALENDAR_ID = "coach@example.com";
    env.GOOGLE_SHEET_ID = "sheet1";
    f.events.push({ id: "x", start: { dateTime: "2026-11-25T07:00:00+07:00" }, end: { dateTime: "2026-11-25T08:00:00+07:00" } });
    const { client, calls } = fakeAnthropic([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "create_booking", input: { start: "2026-11-25T07:00", duration_minutes: 60, student_name: "Lan", phone: null, note: null } } as any] }),
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "create_booking", input: { start: "2026-11-25T09:00", duration_minutes: 60, student_name: "Lan", phone: null, note: null } } as any] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" } as any] }),
    ]);
    await handleUpdate(textUpdate("đặt"), env, { anthropic: client, now: () => NOW });
    expect(calls[1].messages.at(-1).content[0].is_error).toBe(true);
    expect(calls[2].messages.at(-1).content[0].is_error).toBeFalsy();
    const b = JSON.parse(kv.store.get("store:v1")!).bookings[0];
    await adminPost("/admin/booking", { id: b.id, action: "confirm" }, await adminCookie());
    expect(f.events).toHaveLength(2);
    expect(f.events[1].start.dateTime).toBe("2026-11-25T09:00:00+07:00");
  });

  it("bỏ qua tin nhắn trùng message_id và trả lời lệnh /id", async () => {
    await handleUpdate(textUpdate("/id", "dup"), env);
    await handleUpdate(textUpdate("/id", "dup"), env);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("user-1");
  });
});
