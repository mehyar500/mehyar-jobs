// Admin: TCPA-safe contact import.
//
// POST /api/admin/sms/import { contacts: [{ phone, consent_language, consent_source, consent_ts?, tz_offset_min?, user_id? }] }
//
// HARD RULE (2026-09-13 compliance directive): imported numbers are
// recorded as status='pending' — ALWAYS, even when the row carries
// consent_language/consent_source. The broker list has NO consent
// evidence in its schema, so the import metadata is logged as an
// 'import_record' (provenance, NOT a YES) in the consent table. The
// ONLY path to 'active' is the re-permission text: the contact replies
// DEALS/YES and a repermission_yes row is logged with their reply.
// Rows without phone/consent_language/consent_source are rejected.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { normalizePhoneE164 } from "../../../_shared/sms.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const list = Array.isArray(b.contacts) ? b.contacts : [];

  let imported = 0; const rejected = [];
  for (const c of list.slice(0, 50000)) {
    const phone = normalizePhoneE164(c.phone);
    const language = String(c.consent_language || "").trim();
    const source = String(c.consent_source || "").trim();
    if (!phone || !language || !source) { rejected.push({ phone: String(c.phone || "?").slice(0, 8), reason: "missing phone/consent_language/consent_source" }); continue; }
    const ts = c.consent_ts || new Date().toISOString();
    const entry = JSON.stringify([{ ts, language, source, note: "import_record: provenance only, NOT consent" }]);
    const tz = Number.isFinite(Number(c.tz_offset_min)) ? Number(c.tz_offset_min) : null;
    const uid = Number(c.user_id) || null;
    const ex = await db.prepare("SELECT id, status, consent_log_json FROM sms_contact WHERE phone_e164 = ?").bind(phone).first().catch(() => null);
    let contactId;
    if (ex) {
      contactId = ex.id;
      // Never upgrade status on import. Pending stays pending; active
      // contacts keep their status (a YES was already logged for them).
      let log = []; try { log = JSON.parse(ex.consent_log_json || "[]"); } catch {}
      log.push({ ts, language, source, note: "import_record: provenance only, NOT consent" });
      await db.prepare("UPDATE sms_contact SET consent_log_json=?, tz_offset_min=COALESCE(?, tz_offset_min) WHERE id = ?")
        .bind(JSON.stringify(log), tz, ex.id).run().catch(() => {});
    } else {
      const r = await db.prepare("INSERT INTO sms_contact (phone_e164, status, deals_opt_in, consent_log_json, tz_offset_min, user_id) VALUES (?, 'pending', 0, ?, ?, ?)")
        .bind(phone, entry, tz, uid).run().catch(() => null);
      contactId = r?.meta?.last_row_id || null;
      if (!contactId) {
        const row = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164 = ?").bind(phone).first().catch(() => null);
        contactId = row?.id || null;
      }
    }
    if (contactId) {
      // Provenance record — explicitly NOT a YES.
      await db.prepare(
        `INSERT INTO sms_consent (contact_id, phone_e164, kind, consent_text, source_cohort, double_optin_reply)
         VALUES (?, ?, 'import_record', ?, ?, '')`
      ).bind(contactId, phone, `IMPORT provenance only — not consent. Claimed: ${language.slice(0, 200)}`, source.slice(0, 80)).run().catch(() => {});
    }
    imported++;
  }
  return json({
    ok: true,
    imported,
    status: "pending — re-permission text is the only activation path",
    rejected: rejected.slice(0, 20),
    rejected_count: rejected.length,
  }, 200, request, env);
}
