/**
 * Trang quản lý cho HLV (mở trên điện thoại): duyệt lịch, xem ghi danh lớp ghép, đọc tin nhắn khách.
 * Đăng nhập bằng ADMIN_KEY, lưu cookie 30 ngày.
 */
import { COACH } from "./config";
import type { GoogleClient } from "./google";
import { ACTIVE, type Booking, type Store } from "./store";
import { epochToVnTime, formatVn, toRfc3339Vn } from "./time";
import type { ZaloBot } from "./zalo";

export interface AdminDeps {
  adminKey: string;
  store: Store;
  bot: ZaloBot;
  google: GoogleClient | null;
  now: () => number;
  /** Trạng thái thêm cho trang /admin/status */
  status: () => Promise<unknown>;
  setWebhook: () => Promise<unknown>;
}

const COOKIE = "coach_admin";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function isAuthed(req: Request, url: URL, adminKey: string): Promise<boolean> {
  if (!adminKey) return false;
  const key = url.searchParams.get("key");
  if (key && safeEqual(key, adminKey)) return true;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = new RegExp(`${COOKIE}=([a-f0-9]{64})`).exec(cookie);
  return !!m && safeEqual(m[1]!, await sha(`admin:${adminKey}`));
}

async function loginCookie(adminKey: string) {
  return `${COOKIE}=${await sha(`admin:${adminKey}`)}; Path=/admin; Max-Age=${30 * 86_400}; HttpOnly; Secure; SameSite=Strict`;
}

const redirect = (to: string, cookie?: string) =>
  new Response(null, { status: 303, headers: { Location: to, ...(cookie ? { "Set-Cookie": cookie } : {}) } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function page(title: string, body: string, tab: "lich" | "tin" | "") {
  return new Response(
    `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f4f6f8;--card:#fff;--ink:#1d2430;--mute:#6b7280;--line:#e5e7eb;--brand:#0a7cff;--ok:#16a34a;--bad:#dc2626;--warn:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#181e26;--ink:#e6e9ee;--mute:#9aa3ae;--line:#2a323d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:var(--brand);color:#fff;padding:12px 16px;z-index:2}
header h1{margin:0;font-size:17px}nav{display:flex;gap:8px;margin-top:8px}
nav a{color:#fff;text-decoration:none;padding:4px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:14px}
nav a.on{background:#fff;color:var(--brand);font-weight:600}
main{padding:12px 16px 40px;max-width:760px;margin:0 auto}h2{font-size:16px;margin:20px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:8px 0}
.mute{color:var(--mute);font-size:13px}.big{font-weight:600;font-size:16px}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.pending{color:var(--warn)}.confirmed{color:var(--ok)}.rejected,.cancelled{color:var(--bad)}
form.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
input[type=text],input[type=password]{flex:1;min-width:140px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
button{border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;color:#fff;background:var(--brand);cursor:pointer}
button.ok{background:var(--ok)}button.bad{background:var(--bad)}button.ghost{background:transparent;color:var(--mute);border:1px solid var(--line)}
a.item{display:block;color:inherit;text-decoration:none}
.bubble{max-width:85%;padding:8px 12px;border-radius:14px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word}
.user{background:var(--card);border:1px solid var(--line)}.bot{background:var(--brand);color:#fff;margin-left:auto}
.note{background:#fff7e6;color:#7a4b00;border:1px solid #f5d7a1;border-radius:10px;padding:10px;margin:8px 0;font-size:14px}
@media (prefers-color-scheme:dark){.note{background:#2b2111;color:#f5d7a1;border-color:#5c4419}}
</style></head><body><header><h1>🎾 ${esc(COACH.name)} – Quản lý</h1>${
      tab
        ? `<nav><a href="/admin" class="${tab === "lich" ? "on" : ""}">Lịch &amp; ghi danh</a><a href="/admin/chats" class="${tab === "tin" ? "on" : ""}">Tin nhắn khách</a></nav>`
        : ""
    }</header><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

const STATUS_VI: Record<string, string> = {
  pending: "Chờ duyệt",
  confirmed: "Đã xác nhận",
  rejected: "Từ chối",
  cancelled: "Đã huỷ",
};

function bookingCard(b: Booking, actions: string) {
  return `<div class="card"><div class="big">${esc(formatVn(b.start))}–${esc(epochToVnTime(b.end))}</div>
<div><b>${esc(b.studentName)}</b>${b.phone ? ` · <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ""} <span class="pill ${b.status}">${STATUS_VI[b.status]}</span></div>
<div class="mute">${esc(b.price)}</div>
${b.note ? `<div class="mute">Ghi chú: ${esc(b.note)}</div>` : ""}
${b.reason ? `<div class="mute">Lý do: ${esc(b.reason)}</div>` : ""}
<div class="mute">Zalo: ${esc(b.zaloName)} · mã ${esc(b.id)} · gửi lúc ${esc(formatVn(b.createdAt))}</div>${actions}</div>`;
}

const bookingForm = (id: string, buttons: string, withReason: boolean) =>
  `<form class="row" method="post" action="/admin/booking"><input type="hidden" name="id" value="${esc(id)}">${
    withReason ? `<input type="text" name="reason" placeholder="Lời nhắn/lý do (không bắt buộc)">` : ""
  }${buttons}</form>`;

async function dashboard(d: AdminDeps, flash: string | null) {
  const now = d.now();
  const { bookings, groupRegs } = await d.store.load();
  const coachId = await d.store.coachChatId();
  const upcoming = bookings.filter((b) => b.end > now).sort((a, b) => a.start - b.start);
  const pending = upcoming.filter((b) => b.status === "pending");
  const confirmed = upcoming.filter((b) => b.status === "confirmed");
  const history = bookings
    .filter((b) => !(b.end > now && ACTIVE.includes(b.status)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 15);
  const regs = [...groupRegs].sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === "new" ? -1 : 1));

  let html = flash ? `<div class="note">${esc(flash)}</div>` : "";
  if (!coachId)
    html += `<div class="note">🔕 Chưa bật thông báo Zalo cho HLV. Từ Zalo của anh, nhắn cho bot: <b>/hlv &lt;mã quản trị&gt;</b> (mã quản trị = ADMIN_KEY).</div>`;

  html += `<h2>⏳ Chờ duyệt (${pending.length})</h2>`;
  html += pending.length
    ? pending
        .map((b) =>
          bookingCard(
            b,
            bookingForm(
              b.id,
              `<button class="ok" name="action" value="confirm">Xác nhận</button><button class="bad" name="action" value="reject">Từ chối</button>`,
              true,
            ),
          ),
        )
        .join("")
    : `<div class="mute">Không có yêu cầu nào.</div>`;

  html += `<h2>✅ Lịch sắp tới (${confirmed.length})</h2>`;
  html += confirmed.length
    ? confirmed
        .map((b) =>
          bookingCard(
            b,
            `<details><summary class="mute">Huỷ buổi này</summary>${bookingForm(
              b.id,
              `<button class="bad" name="action" value="cancel">Huỷ &amp; báo học viên</button>`,
              true,
            )}</details>`,
          ),
        )
        .join("")
    : `<div class="mute">Chưa có lịch nào.</div>`;

  html += `<h2>👥 Ghi danh lớp ghép (${regs.filter((r) => r.status === "new").length} mới)</h2>`;
  html += regs.length
    ? regs
        .map(
          (r) => `<div class="card" style="${r.status === "contacted" ? "opacity:.6" : ""}"><div class="big">${esc(r.studentName)} · <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>
<div>Mong muốn: ${esc(r.preferredSchedule)}</div>${r.note ? `<div class="mute">Ghi chú: ${esc(r.note)}</div>` : ""}
<div class="mute">Zalo: ${esc(r.zaloName)} · ${esc(formatVn(r.createdAt))}</div>${
            r.status === "new"
              ? `<form class="row" method="post" action="/admin/group"><input type="hidden" name="id" value="${esc(r.id)}"><button class="ghost" name="action" value="contacted">Đánh dấu đã liên hệ</button></form>`
              : `<div class="mute">✔ Đã liên hệ</div>`
          }</div>`,
        )
        .join("")
    : `<div class="mute">Chưa có ai ghi danh.</div>`;

  if (history.length) {
    html += `<h2>🗂 Gần đây</h2>` + history.map((b) => bookingCard(b, "")).join("");
  }
  return page("Quản lý lịch", html, "lich");
}

async function chatsPage(d: AdminDeps) {
  const items = await d.store.chatIndex();
  const html = items.length
    ? items
        .map(
          (i) => `<a class="item card" href="/admin/chat?k=${encodeURIComponent(i.key)}"><div class="big">${esc(i.name || "(không tên)")}</div>
<div>${esc(i.lastText)}</div><div class="mute">${esc(formatVn(i.lastAt))} · ${i.count} tin</div></a>`,
        )
        .join("")
    : `<div class="mute">Chưa có tin nhắn nào.</div>`;
  return page("Tin nhắn khách", `<h2>💬 Khách đã nhắn (${items.length})</h2>${html}`, "tin");
}

async function chatPage(d: AdminDeps, key: string) {
  const log = await d.store.chatLog(key);
  if (!log) return page("Không tìm thấy", `<div class="mute">Không tìm thấy hội thoại.</div>`, "tin");
  const html =
    `<h2>💬 ${esc(log.name || "(không tên)")}</h2><div class="mute">${log.chatType === "GROUP" ? "Nhóm" : "Nhắn riêng"} · ${log.messages.length} tin gần nhất</div>` +
    log.messages
      .map(
        (m) =>
          `<div class="bubble ${m.role}">${esc(m.text)}<div class="mute" style="${m.role === "bot" ? "color:rgba(255,255,255,.75)" : ""}">${esc(formatVn(m.t))}</div></div>`,
      )
      .join("");
  return page(`Tin nhắn – ${log.name}`, html, "tin");
}

/** Báo học viên qua Zalo và ghi vào nhật ký hội thoại. */
async function tellStudent(d: AdminDeps, b: Booking, text: string) {
  await d.bot.sendText(b.chatId, text);
  await d.store.logChat(
    { chatId: b.chatId, userId: b.zaloUserId, name: b.zaloName, chatType: "PRIVATE" },
    [{ t: d.now(), role: "bot", text }],
  );
}

async function bookingAction(d: AdminDeps, form: FormData): Promise<string> {
  const id = String(form.get("id") ?? "");
  const action = String(form.get("action") ?? "");
  const reason = String(form.get("reason") ?? "").trim() || null;
  const now = d.now();
  const target: Record<string, { from: Booking["status"][]; to: Booking["status"] }> = {
    confirm: { from: ["pending"], to: "confirmed" },
    reject: { from: ["pending"], to: "rejected" },
    cancel: { from: ["confirmed", "pending"], to: "cancelled" },
  };
  const t = target[action];
  if (!t) return "Thao tác không hợp lệ.";
  const b = await d.store.update(now, (doc) => {
    const x = doc.bookings.find((y) => y.id === id);
    if (!x || !t.from.includes(x.status)) return null;
    x.status = t.to;
    x.reason = reason;
    x.updatedAt = now;
    return { ...x };
  });
  if (!b) return "Lịch này đã được xử lý trước đó.";

  const when = `${formatVn(b.start)}–${epochToVnTime(b.end)}`;
  const where = COACH.locations.length ? `\nĐịa điểm: ${COACH.locations.join("; ")}` : "";
  const msg = reason ? `\nLời nhắn từ HLV: ${reason}` : "";
  try {
    if (action === "confirm") {
      if (d.google) {
        try {
          const ev = await d.google.createEvent({
            summary: `🎾 1 kèm 1: ${b.studentName} (${b.durationMin}')`,
            description: `${b.studentName}${b.phone ? ` – ${b.phone}` : ""}\n${b.price}\n${b.note ?? ""}`,
            start: toRfc3339Vn(b.start),
            end: toRfc3339Vn(b.end),
            privateProps: { zaloUserId: b.zaloUserId, bookingId: b.id },
          });
          await d.store.update(now, (doc) => {
            const x = doc.bookings.find((y) => y.id === b.id);
            if (x) x.googleEventId = ev.id;
          });
        } catch (e) {
          console.error("google createEvent failed", e);
        }
      }
      await tellStudent(d, b, `✅ HLV đã XÁC NHẬN lịch học 1 kèm 1 của ${b.studentName}:\n${when}\n${b.price}${where}${msg}\nHẹn gặp anh/chị trên sân! 🎾`);
      return `Đã xác nhận và nhắn cho ${b.studentName}.`;
    }
    if (action === "reject") {
      await tellStudent(d, b, `Dạ, HLV báo khung giờ ${when} không nhận được ạ.${msg}\nAnh/chị nhắn em giờ khác để em kiểm tra giúp nhé!`);
      return `Đã từ chối và nhắn cho ${b.studentName}.`;
    }
    if (b.googleEventId && d.google) await d.google.deleteEvent(b.googleEventId).catch(() => {});
    await tellStudent(d, b, `Dạ, HLV xin phép huỷ buổi học ${when}.${msg}\nAnh/chị nhắn em để chọn lại giờ khác nhé, em xin lỗi vì sự bất tiện ạ!`);
    return `Đã huỷ và nhắn cho ${b.studentName}.`;
  } catch (e) {
    console.error("notify student failed", e);
    return `Đã cập nhật trạng thái nhưng KHÔNG nhắn được cho học viên (${String(e)}). Anh liên hệ trực tiếp giúp em.`;
  }
}

/** Trả về Response nếu là đường dẫn /admin..., ngược lại null. */
export async function handleAdmin(req: Request, url: URL, d: AdminDeps): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin")) return null;

  if (url.pathname === "/admin/login" && req.method === "POST") {
    const key = String((await req.formData()).get("key") ?? "");
    if (d.adminKey && safeEqual(key, d.adminKey)) return redirect("/admin", await loginCookie(d.adminKey));
    return page("Đăng nhập", loginForm("Sai mã quản trị."), "");
  }

  if (!(await isAuthed(req, url, d.adminKey))) {
    if (url.pathname.startsWith("/admin/") && url.pathname !== "/admin/") return json({ message: "Unauthorized" }, 403);
    return page("Đăng nhập", loginForm(null), "");
  }

  // Đăng nhập bằng ?key= thì lưu cookie rồi bỏ key khỏi URL (trừ các API JSON).
  const viaKey = url.searchParams.has("key");
  const flash = url.searchParams.get("msg");

  switch (url.pathname) {
    case "/admin":
    case "/admin/":
      if (viaKey) return redirect("/admin", await loginCookie(d.adminKey));
      return dashboard(d, flash);
    case "/admin/chats":
      return chatsPage(d);
    case "/admin/chat":
      return chatPage(d, url.searchParams.get("k") ?? "");
    case "/admin/booking":
      if (req.method !== "POST") return redirect("/admin");
      return redirect(`/admin?msg=${encodeURIComponent(await bookingAction(d, await req.formData()))}`);
    case "/admin/group": {
      if (req.method !== "POST") return redirect("/admin");
      const id = String((await req.formData()).get("id") ?? "");
      await d.store.update(d.now(), (doc) => {
        const r = doc.groupRegs.find((x) => x.id === id);
        if (r) r.status = "contacted";
      });
      return redirect("/admin");
    }
    case "/admin/set-webhook":
      try {
        return json(await d.setWebhook());
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    case "/admin/status":
      return json(await d.status());
  }
  return new Response("Not found", { status: 404 });
}

function loginForm(error: string | null) {
  return `<h2>Đăng nhập</h2>${error ? `<div class="note">${esc(error)}</div>` : ""}
<form class="row" method="post" action="/admin/login"><input type="password" name="key" placeholder="Mã quản trị (ADMIN_KEY)" autocomplete="current-password"><button>Vào</button></form>
<p class="mute">Đăng nhập 1 lần, điện thoại sẽ nhớ trong 30 ngày.</p>`;
}
