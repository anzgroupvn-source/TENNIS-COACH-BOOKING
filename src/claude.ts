/**
 * Vòng hội thoại với Claude: lưu lịch sử theo từng người dùng trong KV, gọi công cụ đặt lịch.
 *
 * Lưu ý kỹ thuật (preserved thinking): lịch sử chỉ được NỐI THÊM, không sửa/xoá lượt cũ,
 * system prompt giữ nguyên trong suốt một phiên. Khi cần "dọn" thì bắt đầu phiên mới hoàn toàn.
 */
import Anthropic from "@anthropic-ai/sdk";
import { COACH, LESSON_DURATIONS, MIN_BOOKING_NOTICE_HOURS, POLICIES, PRICES, WORKING_HOURS } from "./config";
import { formatVn } from "./time";
import { TOOLS, runTool, type ToolContext } from "./tools";

type MessageParam = Anthropic.Beta.BetaMessageParam;

const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "server-side-fallback-2026-07-01", // tự chuyển model dự phòng nếu model chính từ chối
  "thinking-binding-controls-2026-08-01", // cho phép block_binding: drop_block
];
const MAX_TOOL_ROUNDS = 6;
/** Phiên hội thoại mới nếu im lặng quá lâu hoặc quá dài. Lịch đã đặt nằm trên Google Calendar nên không mất. */
const SESSION_IDLE_MS = 6 * 3_600_000;
const SESSION_MAX_MESSAGES = 60;
const HISTORY_TTL_SECONDS = 7 * 86_400;

const DAY_NAMES = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

export const SYSTEM_PROMPT = `Bạn là trợ lý ảo trên Zalo của ${COACH.name} — huấn luyện viên tennis. Bạn nói chuyện với học viên và người quan tâm học tennis.

Nhiệm vụ:
1. Tư vấn về tennis (kỹ thuật cơ bản, dụng cụ, lộ trình học, luật chơi) ngắn gọn, thân thiện, dễ hiểu.
2. Giới thiệu khoá học, học phí, địa điểm theo đúng thông tin bên dưới. Không tự bịa giá, ưu đãi hay cam kết ngoài thông tin này.
3. Giúp đặt lịch, xem lịch và huỷ lịch bằng các công cụ được cung cấp.

Thông tin HLV: ${COACH.bio}
Địa điểm: ${COACH.locations.join("; ")}
Liên hệ: ${COACH.contact}

Học phí:
${PRICES.map((p) => `- ${p.name}: ${p.price}`).join("\n")}

Giờ dạy (giờ Việt Nam):
${[1, 2, 3, 4, 5, 6, 0]
  .map((d) => `- ${DAY_NAMES[d]}: ${(WORKING_HOURS[d] ?? []).map(([a, b]) => `${a}–${b}`).join(", ") || "nghỉ"}`)
  .join("\n")}
Thời lượng buổi học: ${LESSON_DURATIONS.join(", ")} phút. Đặt trước ít nhất ${MIN_BOOKING_NOTICE_HOURS} tiếng.

Chính sách:
${POLICIES.map((p) => `- ${p}`).join("\n")}

Quy trình đặt lịch:
- Hỏi ngày/khung giờ mong muốn và thời lượng (mặc định 60 phút) nếu học viên chưa nói.
- Luôn dùng check_availability để xem giờ trống; không bao giờ tự đoán giờ trống.
- Trước khi gọi create_booking, tóm tắt lại (ngày, giờ, thời lượng, tên học viên) và chờ học viên xác nhận "đồng ý/ok/chốt".
- Cần tên học viên; số điện thoại là tuỳ chọn, hỏi nhẹ nhàng một lần.
- Muốn huỷ: dùng list_my_bookings, xác nhận đúng buổi, rồi mới cancel_booking.
- Đầu mỗi tin nhắn của người dùng có dòng [Thời điểm hiện tại: ...] do hệ thống chèn; dùng nó để hiểu "hôm nay", "mai", "thứ 7 này". Không nhắc lại dòng đó.

Phong cách trả lời:
- Tiếng Việt, xưng "em", gọi người dùng là "anh/chị" (hoặc theo cách họ tự xưng).
- Tin nhắn Zalo nên ngắn: thường dưới 120 từ. Chỉ dùng **in đậm** và gạch đầu dòng "- "; không dùng bảng hay tiêu đề.
- Câu hỏi ngoài phạm vi tennis/đặt lịch: trả lời lịch sự, ngắn, rồi hướng về chủ đề chính.
- Không hứa thay HLV những điều không có trong thông tin trên; khi không chắc, đề nghị nhắn trực tiếp HLV.`;

interface StoredHistory {
  promptHash: string;
  model: string;
  updatedAt: number;
  messages: MessageParam[];
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ChatEnv {
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  BOT_KV: KVNamespace;
}

export function historyKey(chatId: string, userId: string) {
  return `hist:${chatId}:${userId}`;
}

export async function resetHistory(env: ChatEnv, chatId: string, userId: string) {
  await env.BOT_KV.delete(historyKey(chatId, userId));
}

export async function chat(
  env: ChatEnv,
  chatId: string,
  userText: string,
  ctx: ToolContext,
  client: Anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 25_000 }),
): Promise<string> {
  const model = env.CLAUDE_MODEL || "claude-opus-5-5";
  const effort = (env.CLAUDE_EFFORT || "low") as "low" | "medium" | "high";
  const promptHash = await sha256(SYSTEM_PROMPT + JSON.stringify(TOOLS));
  const key = historyKey(chatId, ctx.zaloUserId);
  const now = ctx.now();

  const stored = await env.BOT_KV.get<StoredHistory>(key, "json");
  const sameSession =
    stored &&
    stored.promptHash === promptHash &&
    stored.model === model &&
    now - stored.updatedAt < SESSION_IDLE_MS &&
    stored.messages.length < SESSION_MAX_MESSAGES;
  const messages: MessageParam[] = sameSession ? [...stored.messages] : [];

  messages.push({
    role: "user",
    content: `[Thời điểm hiện tại: ${formatVn(now)} (giờ VN)]\n${userText}`,
  });

  let reply = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: "default",
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      // Không lưu lượt này để lịch sử vẫn sạch.
      return "Xin lỗi, em không thể hỗ trợ nội dung này. Anh/chị cần tư vấn về tennis hay đặt lịch học thì cứ nhắn em nhé!";
    }

    // Nối nguyên vẹn nội dung trả về (kể cả thinking block) — không chỉnh sửa.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        const r = await runTool(t.name, t.input, ctx);
        results.push({ type: "tool_result", tool_use_id: t.id, content: r.content, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    reply = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    break;
  }

  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    // Hết số vòng công cụ mà vẫn đang chờ: không lưu lượt dở dang (tránh lịch sử hỏng).
    return reply || "Em đang xử lý hơi lâu, anh/chị nhắn lại giúp em nhé!";
  }

  const toStore: StoredHistory = { promptHash, model, updatedAt: now, messages };
  await env.BOT_KV.put(key, JSON.stringify(toStore), { expirationTtl: HISTORY_TTL_SECONDS });

  return reply || "Dạ, anh/chị cần em hỗ trợ gì thêm ạ?";
}
