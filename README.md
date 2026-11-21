# Bot Zalo "Coach Nguyễn Đức": tư vấn bằng Claude và đặt lịch học tennis

Học viên nhắn tin cho bot Zalo. Claude trả lời câu hỏi về tennis, học phí và khoá học, đồng thời báo giá chính xác. Khi học viên muốn học 1 kèm 1, bot **giữ chỗ** và báo HLV. HLV bấm **Xác nhận** hoặc **Từ chối** trên trang quản lý, rồi bot tự nhắn lại cho học viên. HLV cũng đọc được toàn bộ tin nhắn khách gửi cho bot trên trang này.

```
Học viên (Zalo) ──► Zalo Bot Platform ──webhook──► Cloudflare Worker ──► Claude API
                                                         │
                                                         ├──► Cloudflare KV (lịch, ghi danh, nhật ký tin nhắn)
                                                         ├──► Trang quản lý /admin (HLV duyệt lịch, đọc tin nhắn)
                                                         └──► Google Calendar/Sheets (tuỳ chọn)
```

## Bot làm được gì

| Học viên nhắn | Bot làm |
|---|---|
| Hỏi về tennis, học phí, địa điểm | Tư vấn chuyên sâu theo thông tin trong `src/config.ts` |
| "Thứ 7 này còn giờ nào không?" | Báo giờ còn trống, đã trừ các giờ có người giữ chỗ |
| "Học 1 kèm 1 tối thứ 7 bao nhiêu?" | Tính chính xác học phí 300k/giờ + phí sân theo ngày/giờ |
| "Chốt 7h sáng thứ 4, tên Lan" | Tóm tắt, chờ học viên đồng ý, **giữ chỗ** và báo HLV duyệt |
| "Lịch của em được chưa?" | Báo trạng thái: chờ HLV xác nhận / đã xác nhận / HLV từ chối |
| "Cho em đăng ký lớp ghép" | Lấy tên, SĐT, khung giờ mong muốn rồi báo HLV để HLV xếp lớp |
| "Huỷ buổi thứ 4 giúp em" | Huỷ lịch của chính người đó (lịch đã xác nhận phải huỷ trước 12 tiếng), báo HLV |
| `/reset` | Bắt đầu cuộc trò chuyện mới |

Các quy tắc như giờ dạy, giờ đặt tối thiểu và chống đặt trùng đều được **kiểm tra trong code**, không phụ thuộc vào AI.

## Dành cho HLV

**Trang quản lý:** `https://tennis-coach-bot.<tên>.workers.dev/admin`. Lần đầu anh nhập mã quản trị (ADMIN_KEY), điện thoại sẽ nhớ trong 30 ngày.
- **Lịch & ghi danh:** các yêu cầu chờ duyệt có nút **Xác nhận** / **Từ chối** và ô lời nhắn gửi kèm cho học viên. Ngoài ra có danh sách lịch sắp tới (huỷ được), danh sách ghi danh lớp ghép (bấm số điện thoại để gọi) và các lịch gần đây.
- **Tin nhắn khách:** danh sách khách đã nhắn và toàn bộ hội thoại giữa khách với bot (lưu 180 ngày).

**Bật thông báo Zalo** (làm 1 lần): từ Zalo của HLV, nhắn cho bot `/hlv <ADMIN_KEY>`. Từ đó mỗi yêu cầu đặt lịch, ghi danh hay huỷ lịch sẽ được gửi về Zalo của HLV, kèm link trang quản lý.

> Lưu ý: bot lưu nội dung tin nhắn của khách để HLV xem lại. Theo Nghị định 13/2023 về bảo vệ dữ liệu cá nhân, nên báo cho khách biết điều này, ví dụ trong lời chào của bot hoặc phần mô tả của bot.

---

## Cách deploy nhanh nhất: nối GitHub với Cloudflare (không cần dòng lệnh)

1. Vào https://dash.cloudflare.com, chọn **Workers & Pages** rồi bấm **Create application**.
2. Chọn **Import a repository** (hoặc **Continue with GitHub**) và cho phép Cloudflare truy cập repo `TENNIS-COACH-BOOKING`.
3. Chọn repo. Ở **Project name** đặt đúng `tennis-coach-bot`, các mục khác giữ mặc định, rồi bấm **Deploy**.
4. Chờ build xong (1–2 phút). Cloudflare tự tạo KV và hiện link dạng `https://tennis-coach-bot.<tên>.workers.dev`.
5. Mở Worker vừa tạo, vào **Settings → Variables and Secrets → Add**, chọn kiểu **Secret** và thêm lần lượt:
   - `ZALO_BOT_TOKEN`: token bot Zalo
   - `ANTHROPIC_API_KEY`: khoá Claude API `sk-ant-...`
   - `ADMIN_KEY`: tự đặt một chuỗi khó đoán, ít nhất 16 ký tự
6. Mở `https://tennis-coach-bot.<tên>.workers.dev/admin/set-webhook?key=<ADMIN_KEY>` để nối bot Zalo với Worker.
7. Nhắn thử cho bot trên Zalo.

Từ đó, mỗi lần code trên GitHub được cập nhật, Cloudflare sẽ tự deploy lại.

## Hướng dẫn cài đặt bằng dòng lệnh (khoảng 30–45 phút)

### Bước 1: Tạo khoá Claude API
1. Vào https://console.anthropic.com và đăng ký bằng email công ty.
2. Vào **Billing** và nạp tiền (tối thiểu khoảng 5 USD).
3. Vào **API Keys**, chọn **Create Key** rồi lưu lại khoá (dạng `sk-ant-...`).

> Chi phí tham khảo: mặc định dùng Claude Opus 5.5 ở mức suy nghĩ `medium` (tư vấn chuyên sâu). Một cuộc hội thoại đặt lịch tốn khoảng vài trăm đồng đến khoảng 1.000đ. Nếu muốn rẻ hơn, sửa `CLAUDE_MODEL = "claude-haiku-5-5"` trong `wrangler.toml`.

### Bước 2 (tuỳ chọn): Nối Google Calendar và Google Sheets
Bỏ qua bước này nếu không cần: bot vẫn giữ chỗ và HLV vẫn duyệt lịch bình thường. Khi nối, bot sẽ tránh thêm các giờ anh bận trên Google Calendar, và mỗi lịch được xác nhận sẽ tự xuất hiện trong lịch Google của anh.
1. Vào https://console.cloud.google.com và tạo một project, ví dụ `tennis-bot`.
2. Vào **APIs & Services → Library** và bật **Google Calendar API** cùng **Google Sheets API**.
3. Vào **IAM & Admin → Service Accounts → Create**. Sau khi tạo xong, mở tab **Keys** và chọn **Add key → JSON** để tải file JSON về.
4. Mở **Google Calendar** của HLV, vào **Cài đặt lịch → Chia sẻ với người cụ thể** và thêm email của service account (dạng `...@...iam.gserviceaccount.com`) với quyền **"Thực hiện thay đổi đối với sự kiện"**.
   - Lấy **ID lịch** ở mục "Tích hợp lịch" (thường chính là email Gmail của HLV).
5. Tạo một **Google Sheet** mới:
   - Đổi tên tab thành `Bookings`.
   - Dòng 1 ghi các tiêu đề: `Thời điểm | Hành động | Mã lịch | Học viên | SĐT | Tên Zalo | Zalo ID | Giờ học | Thời lượng | Ghi chú`.
   - Bấm **Chia sẻ** và thêm email service account với quyền **Người chỉnh sửa**.
   - Lấy **ID Sheet**, là đoạn giữa `/d/` và `/edit` trong URL.

### Bước 3: Deploy lên Cloudflare Workers (miễn phí)
Máy cần cài Node.js 20 trở lên.

```bash
npm install
npx wrangler login                       # đăng nhập Cloudflare (tạo tài khoản miễn phí nếu chưa có)
```

Sửa `wrangler.toml`: điền `GOOGLE_CALENDAR_ID` và `GOOGLE_SHEET_ID`.

Đặt các biến bí mật. Mỗi lệnh sẽ hỏi giá trị, anh/chị dán vào rồi Enter:
```bash
npx wrangler secret put ZALO_BOT_TOKEN               # token bot Zalo
npx wrangler secret put ADMIN_KEY                    # tự đặt chuỗi ngẫu nhiên khác
npx wrangler secret put ANTHROPIC_API_KEY            # khoá sk-ant-...
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < duong-dan/file-service-account.json
```

Deploy:
```bash
npm run deploy
```
Lệnh này in ra địa chỉ dạng `https://tennis-coach-bot.<tên>.workers.dev`.

### Bước 4: Nối bot Zalo với Worker
Mở trình duyệt và truy cập (thay `<ADMIN_KEY>` bằng chuỗi đã đặt ở bước 3):
```
https://tennis-coach-bot.<tên>.workers.dev/admin/set-webhook?key=<ADMIN_KEY>
```
Nếu thấy `"verification": { "ok": true ... }` là đã nối thành công. Sau đó kiểm tra toàn bộ cấu hình tại:
```
https://tennis-coach-bot.<tên>.workers.dev/admin/status?key=<ADMIN_KEY>
```

### Bước 5: Bật thông báo cho HLV
1. HLV nhắn `/id` cho bot và nhận được `chat_id`.
2. Điền giá trị đó vào `COACH_ZALO_CHAT_ID` trong `wrangler.toml`, rồi chạy `npm run deploy` lần nữa.

### Bước 6: Cập nhật thông tin kinh doanh
Sửa `src/config.ts`, gồm giới thiệu HLV, địa điểm, học phí, giờ dạy và chính sách (các mục ghi **CẦN CẬP NHẬT**), rồi chạy `npm run deploy`.

---

## Bảo mật
- **Không bao giờ** ghi token, API key hay file JSON vào code hoặc commit lên GitHub. Tất cả được lưu bằng `wrangler secret`.
- Webhook chỉ nhận request có header `X-Bot-Api-Secret-Token` khớp với secret của webhook. Secret này tự sinh từ token bot, hoặc lấy từ `ZALO_WEBHOOK_SECRET` nếu có đặt.
- Học viên chỉ xem và huỷ được lịch do chính tài khoản Zalo của mình đặt.
- Nếu token bot bị lộ: vào [Zalo Bot Creator](https://zalo.me/s/botcreator/), chọn **Thiết lập → Reset token**, chạy lại `wrangler secret put ZALO_BOT_TOKEN` rồi mở lại `/admin/set-webhook`.

## Giới hạn cần biết
- Zalo tính **hạn mức tin nhắn/tháng** cho bot. Mỗi tin bot gửi đều bị tính, kể cả tin báo cho HLV (lỗi 429 nghĩa là đã hết hạn mức).
- Trong **nhóm chat**, bot chỉ nhận tin nhắn khi được @nhắc tên hoặc khi có người trả lời tin của bot (tính năng nhóm của Zalo đang ở bản beta).
- Bot hiện chỉ đọc tin nhắn chữ, chưa đọc được ảnh, tin thoại hay tệp đính kèm.
- Mỗi tin nhắn được xử lý trong tối đa khoảng 30 giây (giới hạn của Cloudflare `waitUntil`). Với mức suy nghĩ `medium` thì thường đủ. Nếu sau này cần xử lý lâu hơn, có thể chuyển sang Cloudflare Queues.

## Phát triển
```bash
npm test           # chạy test (không gọi API thật)
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev   # chạy local
```

| File | Nội dung |
|---|---|
| `src/index.ts` | Nhận webhook, các lệnh `/id` và `/reset`, các trang admin |
| `src/claude.ts` | System prompt, vòng gọi Claude, lưu lịch sử hội thoại trong KV |
| `src/tools.ts` | Các công cụ: xem giờ trống, báo giá, giữ chỗ/xem/huỷ lịch 1 kèm 1, ghi danh lớp ghép |
| `src/store.ts` | Lưu lịch, ghi danh, nhật ký tin nhắn trong Cloudflare KV |
| `src/admin.ts` | Trang quản lý cho HLV |
| `src/pricing.ts` | Tính học phí + phí sân |
| `src/google.ts` | Google Calendar và Sheets (tuỳ chọn, service account) |
| `src/zalo.ts` | Zalo Bot API |
| `src/config.ts` | **Thông tin kinh doanh: anh/chị sửa file này** |
| `src/time.ts` | Xử lý giờ Việt Nam |
