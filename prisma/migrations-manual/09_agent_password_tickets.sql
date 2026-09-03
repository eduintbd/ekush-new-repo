-- Prefetch-proof set-password tickets. 2026-09.
-- Apply via:
--   npx prisma db execute --file prisma/migrations-manual/09_agent_password_tickets.sql \
--     --schema prisma/schema.prisma
--   npx prisma generate
--
-- WHY: the agent onboarding email carried Supabase's own
-- `…/auth/v1/verify?token=…` URL. GoTrue burns that token on the FIRST GET, and
-- corporate mail gateways (Microsoft Defender SafeLinks, Proofpoint URL
-- Defense) and chat link-preview crawlers fetch every URL in a message. For
-- agent F00000 (fintra.com.bd) the token was spent 17 seconds after the invite
-- and 19 seconds after the resend — machine latency, not human — so the agent's
-- own click always landed on `error_code=otp_expired`. Three sessions were
-- minted from those prefetches and not one of them was ever used.
--
-- The fix is to email a ticket URL on x.ekushwml.com instead. A GET renders a
-- page and changes nothing; the Supabase link is minted AND redeemed inside the
-- POST behind a button, which no prefetcher issues. See src/lib/agent-invite.ts.
--
-- Written as raw SQL rather than `prisma db push` so this applies as one
-- additive CREATE TABLE, with no whole-schema diff against production.
-- Column types mirror what Prisma generates for the model (timestamp(3), text).

CREATE TABLE IF NOT EXISTS xsystem.agent_password_tickets (
  -- Matches @default(dbgenerated("gen_random_uuid()")) on the model.
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the token in the emailed URL, never the token. A dump of
  -- this table must not let anyone redeem a live ticket.
  token_hash  text         NOT NULL,
  email       text         NOT NULL,
  agent_id    uuid,
  is_reset    boolean      NOT NULL DEFAULT false,
  expires_at  timestamp(3) NOT NULL,
  -- Stamped inside the claiming UPDATE, which is what makes redemption
  -- single-use even if two requests race.
  redeemed_at timestamp(3),
  created_at  timestamp(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_password_tickets_token_hash_key
  ON xsystem.agent_password_tickets (token_hash);

CREATE INDEX IF NOT EXISTS agent_password_tickets_email_idx
  ON xsystem.agent_password_tickets (email);
