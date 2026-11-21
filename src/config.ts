/**
 * THÔNG TIN KINH DOANH CỦA HLV — chỉnh trực tiếp file này rồi deploy lại.
 * Mục có chữ "CẦN CẬP NHẬT" là chưa có thông tin thật.
 */

export const COACH = {
  name: "Coach Nguyễn Đức",
  bio: "Huấn luyện viên tennis, dạy lớp ghép và học 1 kèm 1.",
  // CẦN CẬP NHẬT: địa chỉ sân. Khi còn trống, bot nói HLV sẽ gửi địa chỉ khi xác nhận lịch.
  locations: [] as string[],
  // CẦN CẬP NHẬT: số điện thoại liên hệ trực tiếp.
  contact: "Nhắn trực tiếp cho HLV qua Zalo.",
};

/** Học 1 kèm 1: học phí theo giờ, CHƯA gồm phí sân. */
export const PRIVATE_TUITION_PER_HOUR = 300_000;

/**
 * Phí sân theo giờ (áp cho học 1 kèm 1). Giờ VN.
 * Thứ 2–6: trước 17:00 100k/giờ, từ 17:00 200k/giờ.
 * Thứ 7, CN: trước 17:00 120k/giờ, từ 17:00 200k/giờ.
 */
export const COURT_FEE = {
  eveningFrom: "17:00",
  weekdayDay: 100_000,
  weekendDay: 120_000,
  evening: 200_000,
};

/** Lớp ghép: đã gồm phí sân. Bot chỉ ghi danh, HLV tự xếp lớp. */
export const GROUP_CLASS = {
  pricePerSession: 200_000,
  sessionMinutes: 60,
  timeRange: "06:00–17:00",
  sessionsPerWeek: 3,
};

/** Thời lượng buổi 1 kèm 1 cho phép (phút). */
export const LESSON_DURATIONS = [60, 120] as const;
export const DEFAULT_DURATION = 60;

/**
 * Giờ dạy 1 kèm 1 theo thứ (giờ VN). 0 = Chủ nhật, 1 = Thứ 2, ... 6 = Thứ 7.
 * Buổi học phải nằm trọn trong khung giờ (vd 2 giờ thì bắt đầu muộn nhất 19:00).
 */
const ALL_DAY: Array<[string, string]> = [["06:00", "21:00"]];
export const WORKING_HOURS: Record<number, Array<[string, string]>> = {
  0: ALL_DAY,
  1: ALL_DAY,
  2: ALL_DAY,
  3: ALL_DAY,
  4: ALL_DAY,
  5: ALL_DAY,
  6: ALL_DAY,
};

/** Bước nhảy giữa các giờ bắt đầu gợi ý (phút). */
export const SLOT_STEP_MINUTES = 30;
/** Phải đặt trước ít nhất bao nhiêu giờ. */
export const MIN_BOOKING_NOTICE_HOURS = 3;
/** Cho đặt xa nhất bao nhiêu ngày tới. */
export const MAX_BOOKING_DAYS_AHEAD = 30;
/** Tự huỷ qua bot phải trước giờ học ít nhất bao nhiêu giờ (muộn hơn thì bot hướng dẫn liên hệ HLV). */
export const MIN_CANCEL_NOTICE_HOURS = 12;

/** Chính sách khác bot được phép nói (chỉ ghi điều đã xác nhận). CẦN CẬP NHẬT nếu có thêm. */
export const POLICIES: string[] = [
  `Muốn huỷ lịch 1 kèm 1 qua bot cần báo trước ${MIN_CANCEL_NOTICE_HOURS} tiếng; muộn hơn thì nhắn trực tiếp HLV.`,
];
