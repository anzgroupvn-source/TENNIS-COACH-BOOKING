/** Client tối giản cho Zalo Bot API: https://bot.zaloplatforms.com/docs/call-api/ */

const API_BASE = "https://bot-api.zaloplatforms.com";
/** Zalo giới hạn 2000 ký tự/tin. Để dư một chút cho an toàn. */
const MAX_TEXT = 1900;

export interface ZaloUpdate {
  event_name: string;
  message?: {
    message_id: string;
    date: number;
    message_type?: string;
    from: { id: string; display_name?: string; is_bot?: boolean };
    chat: { id: string; chat_type: "PRIVATE" | "GROUP" | string };
    text?: string;
    photo_url?: string;
    caption?: string;
    sticker?: string;
  };
}

interface ZaloResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class ZaloError extends Error {
  constructor(
    public method: string,
    public code: number | undefined,
    description: string | undefined,
  ) {
    super(`Zalo ${method} lỗi ${code ?? "?"}: ${description ?? "không rõ"}`);
  }
}

export class ZaloBot {
  constructor(private token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: ZaloResponse<T>;
    try {
      data = (await res.json()) as ZaloResponse<T>;
    } catch {
      throw new ZaloError(method, res.status, `HTTP ${res.status}`);
    }
    if (!data.ok) throw new ZaloError(method, data.error_code, data.description);
    return data.result as T;
  }

  getMe() {
    return this.call("getMe");
  }

  setWebhook(url: string, secretToken: string) {
    return this.call("setWebhook", { url, secret_token: secretToken });
  }

  getWebhookInfo() {
    return this.call("getWebhookInfo");
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // Không quan trọng nếu lỗi.
    }
  }

  /**
   * Gửi văn bản, tự chia nhỏ nếu dài quá 2000 ký tự.
   * Thử định dạng markdown trước; nếu Zalo từ chối thì gửi dạng chữ thường.
   */
  async sendText(chatId: string, text: string): Promise<void> {
    for (const part of splitText(text, MAX_TEXT)) {
      try {
        await this.call("sendMessage", { chat_id: chatId, text: part, parse_mode: "markdown" });
      } catch (err) {
        if (err instanceof ZaloError && err.code === 400) {
          await this.call("sendMessage", { chat_id: chatId, text: part });
        } else {
          throw err;
        }
      }
    }
  }
}

/** Chia văn bản thành các đoạn <= max ký tự, ưu tiên cắt ở chỗ xuống dòng. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
