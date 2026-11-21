#!/usr/bin/env node
/**
 * Deploy bot lên Cloudflare Workers từ GitHub Actions (.github/workflows/deploy.yml).
 *
 * Làm lần lượt:
 *   1. Kiểm tra CLOUDFLARE_API_TOKEN (báo rõ nếu dán nhầm Global API Key, thừa chữ "Bearer", dấu cách...)
 *   2. Xác định tài khoản Cloudflare, tạo KV namespace BOT_KV nếu chưa có
 *   3. wrangler deploy (kèm biến GOOGLE_CALENDAR_ID, GOOGLE_SHEET_ID, COACH_ZALO_CHAT_ID nếu có)
 *   4. Đặt các bí mật (ZALO_BOT_TOKEN, ANTHROPIC_API_KEY, ...) bằng wrangler secret bulk
 *   5. Gọi /admin/set-webhook để nối bot Zalo, rồi /admin/status để kiểm tra
 *
 * Chỉ chạy trong CI: script sửa wrangler.toml tại chỗ để điền KV id.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER_NAME = "tennis-coach-bot";
const KV_TITLE = `${WORKER_NAME}-BOT_KV`;
const CF_API = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4"; // CF_API_BASE chỉ dùng khi test
const SECRET_NAMES = [
  "ZALO_BOT_TOKEN",
  "ZALO_WEBHOOK_SECRET",
  "ADMIN_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
];
const VAR_NAMES = ["GOOGLE_CALENDAR_ID", "GOOGLE_SHEET_ID", "COACH_ZALO_CHAT_ID", "CLAUDE_MODEL"];

const summary = [];
const log = (s = "") => console.log(s);
const note = (s) => {
  log(s);
  summary.push(s);
};
function fail(msg) {
  console.log(`::error::${msg.split("\n")[0]}`);
  note(`\n❌ **${msg}**`);
  flushSummary();
  process.exit(1);
}
function flushSummary() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}
const mask = (v) => {
  if (v && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${v}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.CI) fail("Script này chỉ dành cho GitHub Actions (CI). Ở máy local hãy dùng `npm run deploy`.");

// ---------- 1. Token ----------
note("## Deploy bot Zalo lên Cloudflare\n");
let token = process.env.CLOUDFLARE_API_TOKEN ?? "";
if (!token) {
  fail(
    "Chưa có secret CLOUDFLARE_API_TOKEN. Vào GitHub repo → Settings → Secrets and variables → Actions → New repository secret.",
  );
}
const cleaned = token.trim().replace(/^bearer\s+/i, "").trim();
if (cleaned !== token) {
  note("⚠️ Token có dấu cách/xuống dòng thừa hoặc chữ `Bearer` ở đầu. Em đã tự bỏ đi; anh nên sửa lại secret cho sạch.");
  token = cleaned;
  mask(token);
}
if (/\s/.test(token)) fail("Token chứa dấu cách ở giữa: có vẻ đã dán cả câu lệnh curl. Hãy dán lại chỉ chuỗi token.");
if (/^[0-9a-f]{37}$/i.test(token)) {
  fail(
    "Đây là Global API Key (37 ký tự hex), không phải API Token. Vào dash.cloudflare.com/profile/api-tokens → Create Token → mẫu \"Edit Cloudflare Workers\".",
  );
}
log(`Token dài ${token.length} ký tự.`);

const CF_HINT = {
  6003: "Token sai định dạng. Hãy tạo lại API Token và chỉ dán đúng chuỗi token.",
  6111: "Token sai định dạng. Hãy tạo lại API Token và chỉ dán đúng chuỗi token.",
  1000: "Token không hợp lệ (đã bị xoá, hết hạn hoặc dán thiếu ký tự).",
  9109: "Token không hợp lệ (đã bị xoá, hết hạn hoặc dán thiếu ký tự).",
  10000: "Token không đủ quyền. Hãy tạo token từ mẫu \"Edit Cloudflare Workers\".",
};
async function cf(path, init = {}) {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const data = await res.json().catch(() => ({ success: false, errors: [{ code: res.status, message: `HTTP ${res.status}` }] }));
  if (!data.success) {
    const errs = data.errors ?? [];
    const codes = errs.flatMap((e) => [e.code, ...(e.error_chain ?? []).map((c) => c.code)]);
    const hint = codes.map((c) => CF_HINT[c]).find(Boolean);
    const err = new Error(`${hint ? hint + " " : ""}(Cloudflare ${path}: ${JSON.stringify(errs)})`);
    err.codes = codes;
    throw err;
  }
  return data;
}

// ---------- 2. Tài khoản + KV + subdomain ----------
let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
try {
  if (!accountId) {
    const { result } = await cf("/accounts?per_page=50");
    if (result.length === 0) fail("Token không thấy tài khoản Cloudflare nào. Kiểm tra mục Account Resources khi tạo token.");
    if (result.length > 1) {
      fail(
        `Token thấy ${result.length} tài khoản (${result.map((a) => a.name).join(", ")}). Thêm secret CLOUDFLARE_ACCOUNT_ID là ID tài khoản muốn dùng.`,
      );
    }
    accountId = result[0].id;
    note(`✅ Token hợp lệ, tài khoản: **${result[0].name}**`);
  } else {
    await cf(`/accounts/${accountId}`);
    note("✅ Token hợp lệ.");
  }
} catch (e) {
  fail(String(e.message));
}

let kvId;
try {
  const { result: namespaces } = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  kvId = namespaces.find((n) => n.title === KV_TITLE)?.id;
  if (kvId) {
    log(`KV ${KV_TITLE} đã có: ${kvId}`);
  } else {
    const { result } = await cf(`/accounts/${accountId}/storage/kv/namespaces`, {
      method: "POST",
      body: JSON.stringify({ title: KV_TITLE }),
    });
    kvId = result.id;
    note(`✅ Đã tạo KV ${KV_TITLE}`);
  }
} catch (e) {
  fail(`Không tạo/đọc được KV: ${e.message}`);
}
const tomlPath = "wrangler.toml";
writeFileSync(tomlPath, readFileSync(tomlPath, "utf8").replace("REPLACE_WITH_KV_NAMESPACE_ID", kvId));

let subdomain;
try {
  subdomain = (await cf(`/accounts/${accountId}/workers/subdomain`)).result?.subdomain;
} catch {
  /* xử lý bên dưới */
}
if (!subdomain) {
  fail(
    "Tài khoản Cloudflare chưa có địa chỉ workers.dev. Vào dash.cloudflare.com → Workers & Pages, mở một lần để Cloudflare tạo địa chỉ, rồi chạy lại.",
  );
}
const workerUrl = `https://${WORKER_NAME}.${subdomain}.workers.dev`;

// ---------- 3. Deploy ----------
const childEnv = { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { stdio: "inherit", env: childEnv });

const varArgs = [];
for (const name of VAR_NAMES) {
  const v = (process.env[`VAR_${name}`] ?? "").trim();
  if (v) varArgs.push("--var", `${name}:${v}`);
}
try {
  wrangler(["deploy", ...varArgs]);
} catch {
  fail("wrangler deploy lỗi, xem log phía trên.");
}
note(`✅ Đã deploy: ${workerUrl}`);

// ---------- 4. Bí mật ----------
const secrets = {};
for (const name of SECRET_NAMES) {
  const v = process.env[name] ?? "";
  if (v.trim()) secrets[name] = name === "GOOGLE_SERVICE_ACCOUNT_JSON" ? v : v.trim();
}
// Hai chuỗi này không cần anh nhớ: nếu không đặt trong GitHub thì mỗi lần deploy tự sinh mới
// và webhook được đăng ký lại ngay bên dưới.
for (const name of ["ZALO_WEBHOOK_SECRET", "ADMIN_KEY"]) {
  if (!secrets[name]) {
    secrets[name] = randomBytes(24).toString("hex");
    mask(secrets[name]);
  }
}
const secretFile = join(tmpdir(), `secrets-${process.pid}.json`);
writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
try {
  wrangler(["secret", "bulk", secretFile]);
} catch {
  fail("Không đặt được bí mật cho Worker, xem log phía trên.");
} finally {
  unlinkSync(secretFile);
}
const missing = ["ZALO_BOT_TOKEN", "ANTHROPIC_API_KEY"].filter((n) => !secrets[n]);
note(`✅ Đã đặt bí mật: ${Object.keys(secrets).join(", ")}`);
if (missing.length) note(`⚠️ Còn thiếu: **${missing.join(", ")}**. Bot chưa trả lời được cho tới khi thêm vào GitHub Secrets.`);
if (!secrets.GOOGLE_SERVICE_ACCOUNT_JSON) note("ℹ️ Chưa nối Google Calendar/Sheets: bot tư vấn được nhưng chưa đặt lịch được.");

// ---------- 5. Nối webhook Zalo ----------
async function adminCall(path) {
  // Worker mới hoặc bí mật mới cần vài giây để có hiệu lực: thử lại tối đa ~2 phút.
  let last = "";
  for (let i = 0; i < 24; i++) {
    try {
      const res = await fetch(`${workerUrl}${path}?key=${encodeURIComponent(secrets.ADMIN_KEY)}`);
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 500) break;
    } catch (e) {
      last = String(e);
    }
    await sleep(5000);
  }
  throw new Error(last);
}

if (secrets.ZALO_BOT_TOKEN) {
  try {
    const r = await adminCall("/admin/set-webhook");
    note(`✅ Đã nối webhook Zalo: ${r.webhookUrl}`);
  } catch (e) {
    fail(`Không nối được webhook Zalo: ${e.message}`);
  }
  try {
    const s = await adminCall("/admin/status");
    const botName = s.bot?.account_name ?? s.bot?.display_name ?? s.bot?.name;
    note("\n### Kiểm tra cấu hình");
    note(`- Bot Zalo: ${s.bot?.error ? "❌ " + s.bot.error : "✅ " + (botName ?? "OK")}`);
    note(`- Webhook: ${s.webhook?.error ? "❌ " + s.webhook.error : "✅ " + (s.webhook?.url ?? "OK")}`);
    note(`- Khoá Claude: ${s.config?.anthropicKey ? "✅" : "❌ chưa có"} (model ${s.config?.model})`);
    note(`- Google Calendar: ${s.config?.googleConfigured ? (s.config.googleCalendar === "ok" ? "✅" : "❌ " + JSON.stringify(s.config.googleCalendar)) : "chưa cấu hình"}`);
    note(`- Báo HLV qua Zalo: ${s.config?.coachNotify ? "✅" : "chưa cấu hình (biến COACH_ZALO_CHAT_ID)"}`);
  } catch (e) {
    note(`⚠️ Không đọc được /admin/status: ${e.message}`);
  }
} else {
  note("ℹ️ Chưa có ZALO_BOT_TOKEN nên chưa nối webhook Zalo.");
}

flushSummary();
