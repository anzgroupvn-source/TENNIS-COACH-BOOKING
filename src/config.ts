/**
 * THÔNG TIN KINH DOANH CỦA HLV — anh/chị chỉnh trực tiếp file này rồi deploy lại.
 * Các mục có chữ "CẦN CẬP NHẬT" là số liệu mẫu, chưa phải thông tin thật.
 */

export const COACH = {
  name: "Coach Nguyễn Đức",
  // CẦN CẬP NHẬT: giới thiệu ngắn về HLV (kinh nghiệm, chứng chỉ, phong cách dạy).
  bio: "Huấn luyện viên tennis cho người mới bắt đầu và trình độ trung cấp.",
  // CẦN CẬP NHẬT: địa điểm sân.
  locations: ["Sân tennis (cập nhật địa chỉ)"],
  // CẦN CẬP NHẬT: số điện thoại/Zalo liên hệ trực tiếp khi bot không xử lý được.
  contact: "Liên hệ trực tiếp HLV qua Zalo này.",
};

/** CẦN CẬP NHẬT: bảng giá. */
export const PRICES = [
  { name: "Học 1 kèm 1 (60 phút)", price: "500.000đ/buổi" },
  { name: "Học nhóm 2–3 người (60 phút)", price: "300.000đ/người/buổi" },
  { name: "Gói 10 buổi 1 kèm 1", price: "4.500.000đ" },
];

/** Thời lượng buổi học cho phép (phút). */
export const LESSON_DURATIONS = [60, 90, 120] as const;
export const DEFAULT_DURATION = 60;

/**
 * Giờ dạy theo thứ trong tuần (giờ Việt Nam). 0 = Chủ nhật, 1 = Thứ 2, ... 6 = Thứ 7.
 * Mỗi ngày có thể có nhiều khung giờ. Ngày không có trong danh sách = nghỉ.
 * CẦN CẬP NHẬT theo lịch thật của HLV.
 */
export const WORKING_HOURS: Record<number, Array<[string, string]>> = {
  0: [["06:00", "11:00"], ["15:00", "20:00"]],
  1: [["05:30", "08:30"], ["16:00", "21:00"]],
  2: [["05:30", "08:30"], ["16:00", "21:00"]],
  3: [["05:30", "08:30"], ["16:00", "21:00"]],
  4: [["05:30", "08:30"], ["16:00", "21:00"]],
  5: [["05:30", "08:30"], ["16:00", "21:00"]],
  6: [["06:00", "11:00"], ["15:00", "20:00"]],
};

/** Bước nhảy giữa các giờ bắt đầu gợi ý (phút). */
export const SLOT_STEP_MINUTES = 30;
/** Phải đặt trước ít nhất bao nhiêu giờ. */
export const MIN_BOOKING_NOTICE_HOURS = 3;
/** Cho đặt xa nhất bao nhiêu ngày tới. */
export const MAX_BOOKING_DAYS_AHEAD = 30;
/** Huỷ lịch phải trước giờ học ít nhất bao nhiêu giờ (muộn hơn thì bot hướng dẫn liên hệ HLV). */
export const MIN_CANCEL_NOTICE_HOURS = 12;

/** CẦN CẬP NHẬT: chính sách, lưu ý thêm mà bot nên biết (thanh toán, mưa, dụng cụ...). */
export const POLICIES = [
  "Thanh toán sau buổi học bằng tiền mặt hoặc chuyển khoản.",
  `Huỷ lịch trước ${MIN_CANCEL_NOTICE_HOURS} tiếng để không mất phí.`,
  "Trời mưa sẽ được dời lịch miễn phí.",
  "Học viên mới nên mang giày tennis; HLV có vợt cho mượn.",
];
