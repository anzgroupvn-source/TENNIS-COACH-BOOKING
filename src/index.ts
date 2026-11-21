/**
 * Cloudflare Worker: nhận webhook từ Zalo Bot, trả lời bằng Claude, đặt lịch trên Google Calendar.
 *
 *   POST /webhook                       Zalo gọi vào (xác thực bằng header X-Bot-Api-Secret-Token)
 *   GET  /admin/set-webhook?key=...     Đăng ký URL webhook với Zalo (chạy 1 lần sau khi deploy)
 *   GET  /admin/status?key=...          Kiểm tra bot, webhook, cấu hình
 */
import Anthropic from "@anthropic-ai/sdk";
import { chat, resetHistory, type ChatEnv } from "./claude";
import { GoogleClient } from "./google";
import type { ToolContext } from "./tools";
import { ZaloBot, type ZaloUpdate } from "./zalo";

export interface Env extends ChatEnv {
  ZALO_BOT_TOKEN: string;
  /** Tuỳ chọn. Nếu không đặt, tự sinh từ ZALO_BOT_TOKEN. */
  ZALO_WEBHOOK_SECRET?: string;
  ADMIN_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SHEET_TAB?: string;
  COACH_ZALO_CHAT_ID?: string;
}

const isPlaceholder = (v?: string) => !v || v.startsWith("REPLACE_WITH");

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

/** Secret cho webhook: dùng ZALO_WEBHOOK_SECRET nếu có, không thì băm từ token bot (đổi token = đổi secret). */
export async function webhookSecret(env: Env): Promise<string> {
  if (env.ZALO_WEBHOOK_SECRET) return env.ZALO_WEBHOOK_SECRET;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`zalo-webhook:${env.ZALO_BOT_TOKEN}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function makeGoogle(env: Env): GoogleClient | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || isPlaceholder(env.GOOGLE_CALENDAR_ID) || isPlaceholder(env.GOOGLE_SHEET_ID))
    return null;
  return new GoogleClient(
    env.GOOGLE_SERVICE_ACCOUNT_JSON,
    env.GOOGLE_CALENDAR_ID!,
    env.GOOGLE_SHEET_ID!,
    env.GOOGLE_SHEET_TAB || "Bookings",
  );
}

const NON_TEXT_REPLY: Record<string, string> = {
  "message.image.received": "Em đã nhận được ảnh ạ. Hiện em mới đọc được tin nhắn chữ, anh/chị mô tả giúp em bằng chữ nhé!",
  "message.sticker.received": "😊 Anh/chị cần em tư vấn về khoá học tennis hay đặt lịch học ạ?",
  "message.voice.received": "Hiện em chưa nghe được tin nhắn thoại, anh/chị nhắn chữ giúp em nhé!",
  "message.file.received": "Hiện em chưa đọc được tệp đính kèm, anh/chị nhắn chữ giúp em nhé!",
};

export async function handleUpdate(update: ZaloUpdate, env: Env, deps: { anthropic?: Anthropic; now?: () => number } = {}) {
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const bot = new ZaloBot(env.ZALO_BOT_TOKEN);

  // Chống xử lý trùng khi Zalo gửi lại sự kiện.
  const seenKey = `seen:${msg.message_id}`;
  if (await env.BOT_KV.get(seenKey)) return;
  await env.BOT_KV.put(seenKey, "1", { expirationTtl: 86_400 });

  if (update.event_name !== "message.text.received") {
    const reply = NON_TEXT_REPLY[update.event_name];
    if (reply) await bot.sendText(chatId, reply);
    return;
  }

  const text = (msg.text ?? "").trim();
  if (!text) return;

  if (text === "/id") {
    await bot.sendText(chatId, `chat_id: ${chatId}\nuser_id: ${userId}`);
    return;
  }
  if (text === "/reset" || text === "/moi") {
    await resetHistory(env, chatId, userId);
    await bot.sendText(chatId, "Đã bắt đầu cuộc trò chuyện mới. Em có thể giúp gì cho anh/chị ạ?");
    return;
  }

  await bot.sendTyping(chatId);

  const now = deps.now ?? (() => Date.now());
  const ctx: ToolContext = {
    zaloUserId: userId,
    zaloDisplayName: msg.from.display_name ?? "",
    google: makeGoogle(env),
    now,
    notifyCoach: async (t) => {
      if (!env.COACH_ZALO_CHAT_ID) throw new Error("COACH_ZALO_CHAT_ID chưa cấu hình");
      if (env.COACH_ZALO_CHAT_ID !== chatId) await bot.sendText(env.COACH_ZALO_CHAT_ID, t);
    },
  };

  let reply: string;
  try {
    reply = await chat(env, chatId, text, ctx, deps.anthropic);
  } catch (e) {
    console.error("chat failed", e);
    reply =
      e instanceof Anthropic.RateLimitError
        ? "Hiện có nhiều người nhắn cùng lúc, anh/chị đợi 1 phút rồi nhắn lại giúp em nhé!"
        : "Xin lỗi, em đang gặp sự cố kỹ thuật. Anh/chị vui lòng thử lại sau ít phút nhé!";
  }
  await bot.sendText(chatId, reply);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Bot-Api-Secret-Token") ?? "";
      if (!env.ZALO_BOT_TOKEN || !timingSafeEqual(secret, await webhookSecret(env))) {
        return json({ message: "Unauthorized" }, 403);
      }
      let body: ZaloUpdate & { result?: ZaloUpdate };
      try {
        body = await request.json();
      } catch {
        return json({ message: "Bad request" }, 400);
      }
      const update = body.event_name ? body : body.result;
      // Trả lời Zalo ngay, xử lý ở nền để Zalo không chờ lâu.
      if (update) {
        ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error("handleUpdate failed", e)));
      }
      return json({ message: "Success" });
    }

    if (url.pathname.startsWith("/admin/")) {
      const key = url.searchParams.get("key") ?? "";
      if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) return json({ message: "Unauthorized" }, 403);
      const bot = new ZaloBot(env.ZALO_BOT_TOKEN);

      if (url.pathname === "/admin/set-webhook") {
        const webhookUrl = `${url.origin}/webhook`;
        try {
          return json({ webhookUrl, result: await bot.setWebhook(webhookUrl, await webhookSecret(env)) });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      if (url.pathname === "/admin/status") {
        const settle = async (p: Promise<unknown>) => p.then((v) => v, (e) => ({ error: String(e) }));
        const google = makeGoogle(env);
        return json({
          bot: await settle(bot.getMe()),
          webhook: await settle(bot.getWebhookInfo()),
          config: {
            anthropicKey: Boolean(env.ANTHROPIC_API_KEY),
            model: env.CLAUDE_MODEL || "claude-opus-5-5",
            googleConfigured: Boolean(google),
            googleCalendar: google ? await settle(google.busy(Date.now(), Date.now() + 86_400_000).then(() => "ok")) : null,
            coachNotify: Boolean(env.COACH_ZALO_CHAT_ID),
          },
        });
      }
    }

    if (url.pathname === "/") return new Response("Tennis coach Zalo bot is running.");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
