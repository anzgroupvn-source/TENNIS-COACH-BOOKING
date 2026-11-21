/**
 * Google Calendar + Sheets qua service account (ký JWT RS256 bằng WebCrypto,
 * chạy được trên Cloudflare Workers, không cần thư viện googleapis).
 */
import type { Interval } from "./time";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { token: string; exp: number } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: tokenUri, iat: now, exp: now + 3600 }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google OAuth lỗi ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  status?: string;
}

export class GoogleClient {
  constructor(
    private serviceAccountJson: string,
    private calendarId: string,
    private sheetId: string,
    private sheetTab: string,
  ) {}

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await getAccessToken(this.serviceAccountJson);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private get calBase() {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}`;
  }

  /** Các khoảng bận trên lịch HLV (gồm cả lịch cá nhân HLV tự thêm). */
  async busy(timeMin: number, timeMax: number): Promise<Interval[]> {
    const data = await this.api<{ calendars: Record<string, { busy: Array<{ start: string; end: string }> }> }>(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        body: JSON.stringify({
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
          items: [{ id: this.calendarId }],
        }),
      },
    );
    const cal = data.calendars[this.calendarId];
    return (cal?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }

  createEvent(event: {
    summary: string;
    description: string;
    start: string;
    end: string;
    location?: string;
    privateProps: Record<string, string>;
  }): Promise<CalendarEvent> {
    return this.api<CalendarEvent>(`${this.calBase}/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: { dateTime: event.start, timeZone: "Asia/Ho_Chi_Minh" },
        end: { dateTime: event.end, timeZone: "Asia/Ho_Chi_Minh" },
        extendedProperties: { private: event.privateProps },
      }),
    });
  }

  getEvent(id: string): Promise<CalendarEvent> {
    return this.api<CalendarEvent>(`${this.calBase}/events/${encodeURIComponent(id)}`);
  }

  deleteEvent(id: string): Promise<void> {
    return this.api<void>(`${this.calBase}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Lịch sắp tới do một học viên Zalo đặt. */
  async upcomingEventsFor(zaloUserId: string, from: number): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({
      privateExtendedProperty: `zaloUserId=${zaloUserId}`,
      timeMin: new Date(from).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "20",
    });
    const data = await this.api<{ items?: CalendarEvent[] }>(`${this.calBase}/events?${q}`);
    return (data.items ?? []).filter((e) => e.status !== "cancelled");
  }

  /** Ghi 1 dòng nhật ký vào Google Sheet. */
  async appendRow(values: Array<string | number>): Promise<void> {
    const range = encodeURIComponent(`${this.sheetTab}!A1`);
    await this.api(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [values] }) },
    );
  }
}
