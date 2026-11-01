// Benutzer, Sitzungen und CSRF-Schutz.
import { q, insert } from "./db.js";
import { hashPassword, verifyPassword, token, safeEqual } from "./crypto.js";
import { config } from "./config.js";
import { parseCookies, cookie, fail } from "./http.js";

export const SESSION_COOKIE = "cm_sid";
const SESSION_MS = 12 * 60 * 60 * 1000;

export function ensureAdmin() {
  const count = q.value("SELECT COUNT(*) FROM users");
  if (count > 0 || !config.adminEmail || !config.adminPassword) return null;
  const now = Date.now();
  return insert("users", { email: config.adminEmail, name: config.adminName, password_hash: hashPassword(config.adminPassword), role: "admin", created_at: now });
}

export function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at, last_login_at: u.last_login_at } : null;
}

// Gleichbleibende Laufzeit auch bei unbekannter E-Mail (kein Benutzer-Enumerieren).
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export function login(email, password) {
  const user = q.get("SELECT * FROM users WHERE email = ?", String(email || "").trim().toLowerCase());
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return null;
  const now = Date.now();
  const session = { id: token(32), user_id: user.id, csrf: token(24), expires_at: now + SESSION_MS, created_at: now };
  insert("sessions", session);
  q.run("UPDATE users SET last_login_at = ? WHERE id = ?", now, user.id);
  q.run("DELETE FROM sessions WHERE expires_at < ?", now);
  return { session, user };
}

export function sessionCookie(session) {
  return cookie(SESSION_COOKIE, session.id, { maxAge: SESSION_MS, sameSite: "Lax" });
}
export function clearCookie() {
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

export function authenticate(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = q.get("SELECT s.id AS sid, s.csrf, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?", sid);
  if (!row || row.expires_at < Date.now()) return null;
  // Gleitende Verlängerung, solange gearbeitet wird.
  if (row.expires_at - Date.now() < SESSION_MS / 2) q.run("UPDATE sessions SET expires_at = ? WHERE id = ?", Date.now() + SESSION_MS, row.sid);
  return { session: { id: row.sid, csrf: row.csrf }, user: row };
}

export function checkCsrf(req, session) {
  const header = req.headers["x-csrf-token"];
  if (!header || !safeEqual(header, session.csrf)) fail(403, "CSRF-Prüfung fehlgeschlagen. Bitte Seite neu laden.");
}

export function logout(sessionId) {
  q.run("DELETE FROM sessions WHERE id = ?", sessionId);
}

export function requireAdmin(user) {
  if (user.role !== "admin") fail(403, "Nur für Administratoren");
}
