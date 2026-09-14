-- 0016_consent_table.sql
-- Dedicated YES consent table — the ONLY entry gate to messaging.
--
-- HARD RULE (2026-09-13 compliance directive): no number or address is
-- ever messaged unless a logged YES exists HERE — with phone/email,
-- timestamp, the exact consent language, source cohort, and the
-- double-opt-in reply text. Broker-imported lists (no consent evidence
-- in their schema) import as status='pending' and stay silent until the
-- re-permission text ("reply DEALS") earns a YES, which is logged here.
--
-- A row in this table is proof of consent. sms_contact.consent_log_json
-- is kept as a human-readable mirror; this table is the gate.

CREATE TABLE IF NOT EXISTS sms_consent (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id         INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  phone_e164         TEXT NOT NULL,
  kind               TEXT NOT NULL,            -- repermission_yes | import_record
  consent_text       TEXT NOT NULL,            -- exact language they agreed to
  consent_ts         TEXT NOT NULL DEFAULT (datetime('now')),
  source_cohort      TEXT,                     -- broker_list | web | inbound | import
  double_optin_reply TEXT,                     -- the actual YES / DEALS / START text
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_consent_contact ON sms_consent(contact_id);
CREATE INDEX IF NOT EXISTS idx_sms_consent_phone ON sms_consent(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consent_kind ON sms_consent(kind);
