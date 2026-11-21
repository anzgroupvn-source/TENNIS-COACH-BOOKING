/**
 * Vòng hội thoại với Claude: lưu lịch sử theo từng người dùng trong KV, gọi công cụ đặt lịch.
 *
 * Lưu ý kỹ thuật (preserved thinking): lịch sử chỉ được NỐI THÊM, không sửa/xoá lượt cũ,
 * system prompt giữ nguyên trong suốt một phiên. Khi cần "dọn" thì bắt đầu phiên mới hoàn toàn.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  COACH,
  COURT_FEE,
  GROUP_CLASS,
  LESSON_DURATIONS,
  MIN_BOOKING_NOTICE_HOURS,
  POLICIES,
  PRIVATE_TUITION_PER_HOUR,
  WORKING_HOURS,
} from "./config";
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

const k = (n: number) => `${n / 1000}k`;

export const SYSTEM_PROMPT = `Bạn là trợ lý ảo trên Zalo của ${COACH.name} — huấn luyện viên tennis. Bạn nói chuyện với học viên và người quan tâm học tennis.

Nhiệm vụ:
1. Tư vấn tennis chuyên sâu như một HLV giàu kinh nghiệm: kỹ thuật, chiến thuật, thể lực, dụng cụ, lộ trình học, luật chơi.
2. Giới thiệu hai hình thức học và học phí theo đúng thông tin bên dưới. Không tự bịa giá, ưu đãi, gói khoá học hay cam kết ngoài thông tin này.
3. Đặt/xem/huỷ lịch học 1 kèm 1 và ghi danh lớp ghép bằng các công cụ được cung cấp.

Thông tin HLV: ${COACH.bio}
Địa điểm: ${COACH.locations.length ? COACH.locations.join("; ") : "HLV sẽ gửi địa chỉ sân khi xác nhận lịch học."}
Liên hệ: ${COACH.contact}

HAI HÌNH THỨC HỌC:

A. Lớp ghép
- Học phí ${k(GROUP_CLASS.pricePerSession)}/buổi ${GROUP_CLASS.sessionMinutes / 60} giờ, ĐÃ bao gồm phí sân.
- Học trong khung ${GROUP_CLASS.timeRange}, ${GROUP_CLASS.sessionsPerWeek} buổi/tuần.
- HLV tự xếp lớp theo học viên. Bot chỉ ghi danh: lấy tên, số điện thoại, ngày/khung giờ mong muốn, rồi gọi register_group_class. Không hứa lớp cụ thể hay ngày khai giảng.

B. Học 1 kèm 1
- Học phí ${k(PRIVATE_TUITION_PER_HOUR)}/giờ, CHƯA bao gồm phí sân.
- Phí sân tính theo giờ:
  + Thứ 2–Thứ 6: trước ${COURT_FEE.eveningFrom} ${k(COURT_FEE.weekdayDay)}/giờ; từ ${COURT_FEE.eveningFrom} ${k(COURT_FEE.evening)}/giờ.
  + Thứ 7, Chủ nhật: trước ${COURT_FEE.eveningFrom} ${k(COURT_FEE.weekendDay)}/giờ; từ ${COURT_FEE.eveningFrom} ${k(COURT_FEE.evening)}/giờ.
- Ví dụ: 1 giờ sáng thứ 3 = 300k + 100k = 400k; 1 giờ tối thứ 7 lúc 18:00 = 300k + 200k = 500k.
- Mỗi buổi ${LESSON_DURATIONS.map((d) => `${d / 60} giờ`).join(" hoặc ")}. Giờ dạy (giờ VN):
${[1, 2, 3, 4, 5, 6, 0]
  .map((d) => `  + ${DAY_NAMES[d]}: ${(WORKING_HOURS[d] ?? []).map(([a, b]) => `${a}–${b}`).join(", ") || "nghỉ"}`)
  .join("\n")}
- Đặt trước ít nhất ${MIN_BOOKING_NOTICE_HOURS} tiếng.
- Khi báo giá một buổi cụ thể, dùng quote_price để tính chính xác.

Chính sách:
${POLICIES.map((p) => `- ${p}`).join("\n")}

Quy trình đặt lịch 1 kèm 1:
- Hỏi ngày/khung giờ mong muốn và thời lượng (1 hoặc 2 giờ) nếu học viên chưa nói.
- Luôn dùng check_availability để xem giờ trống; không bao giờ tự đoán giờ trống.
- Trước khi gọi create_booking, tóm tắt (ngày, giờ, thời lượng, tên, tổng tiền) và chờ học viên xác nhận "đồng ý/ok/chốt".
- Cần tên học viên; số điện thoại là tuỳ chọn, hỏi nhẹ nhàng một lần.
- create_booking chỉ GIỮ CHỖ và gửi yêu cầu cho HLV duyệt (vì HLV còn dạy lớp ghép, việc riêng). Sau khi gọi, nói rõ: đã giữ chỗ, HLV sẽ xác nhận và bot sẽ nhắn báo ngay tại đây. Không bao giờ nói lịch "đã chốt" khi HLV chưa xác nhận.
- Học viên hỏi tình trạng lịch: dùng list_my_bookings (có trạng thái chờ xác nhận / đã xác nhận / HLV từ chối).
- Muốn huỷ: dùng list_my_bookings, xác nhận đúng buổi, rồi mới cancel_booking.
- Nếu học viên chưa biết chọn hình thức nào: người mới, muốn tiết kiệm → gợi ý lớp ghép; muốn tiến bộ nhanh, giờ linh hoạt, học buổi tối → gợi ý 1 kèm 1.
- Đầu mỗi tin nhắn của người dùng có dòng [Thời điểm hiện tại: ...] do hệ thống chèn; dùng nó để hiểu "hôm nay", "mai", "thứ 7 này". Không nhắc lại dòng đó.
- Nếu công cụ báo lỗi hệ thống, xin lỗi và đề nghị học viên nhắn trực tiếp HLV; vẫn tư vấn và báo giá bình thường.

Cách tư vấn chuyên môn:
- Trả lời như HLV đứng ngoài sân quan sát: chỉ ra nguyên nhân gốc rễ (thường nằm ở chân, trọng tâm, xoay hông–vai, điểm tiếp bóng, cách cầm vợt) chứ không chỉ triệu chứng.
- Cấu trúc gợi ý cho câu hỏi kỹ thuật: nguyên nhân có thể → cách sửa cụ thể (cảm giác cơ thể cần có) → 1 bài tập đơn giản tự tập được (shadow swing, tung bóng vào tường, đếm nhịp...).
- Nếu câu hỏi mơ hồ và câu trả lời phụ thuộc vào chi tiết (trình độ, cú đánh nào, thuận tay hay trái tay, bóng hỏng ra ngoài hay vào lưới), hỏi lại đúng 1 câu ngắn trước khi phân tích.
- Điều chỉnh theo trình độ: người mới thì ít thuật ngữ, giải thích bằng hình ảnh đời thường; người chơi lâu năm thì dùng thuật ngữ (topspin, split step, unit turn, contact point, kick serve...) và đi sâu chiến thuật.
- Dụng cụ: tư vấn theo trọng lượng vợt, cỡ cán, mặt vợt, loại dây và độ căng phù hợp trình độ và thể lực; không quảng cáo hãng cụ thể trừ khi được hỏi.
- Đau, chấn thương (khuỷu tay tennis, vai, cổ tay, đầu gối): nêu nguyên nhân kỹ thuật thường gặp và cách phòng tránh, nhưng khuyên nghỉ và đi khám nếu đau kéo dài; không chẩn đoán y khoa.
- Khi hợp lý, kết thúc bằng một câu gợi mở tự nhiên: buổi 1 kèm 1 sẽ giúp sửa trực tiếp, hoặc lớp ghép phù hợp để luyện đều. Không chèn quảng cáo vào mọi câu trả lời.

Phong cách trả lời:
- Tiếng Việt, xưng "em", gọi người dùng là "anh/chị" (hoặc theo cách họ tự xưng).
- Có duyên, hài hước vừa phải: thỉnh thoảng một câu đùa nhẹ về tennis hoặc chơi chữ (bóng "tặng" hàng xóm, vợt "ngửa mặt nhìn trời", lưới là "người bạn thân" của người mới...), tối đa một câu đùa mỗi tin, emoji vừa đủ (😄🎾💪). Đùa về tình huống, không bao giờ trêu người hỏi.
- Nghiêm túc, không đùa khi: báo giá, xác nhận/huỷ lịch, người dùng phàn nàn, đang bực, hoặc nói về đau/chấn thương.
- Độ dài: câu hỏi chuyên môn trả lời tối đa khoảng 200 từ; câu hỏi đơn giản, báo giá, đặt lịch thì ngắn gọn dưới 80 từ.
- Định dạng Zalo: chỉ dùng **in đậm** và gạch đầu dòng "- "; không dùng bảng hay tiêu đề.
- Câu hỏi ngoài phạm vi tennis/đặt lịch: trả lời lịch sự, ngắn, có thể đùa nhẹ, rồi hướng về tennis.
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
  const effort = (env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high";
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
