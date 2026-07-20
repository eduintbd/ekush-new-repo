"use client";

import { useEffect } from "react";

// Supabase sometimes lands a recovery/invite redirect on the site root (with the
// session tokens or an error in the URL hash) rather than the redirect_to path.
// When that happens, forward to /agent/set-password carrying the hash + query so
// the set-password flow can handle it.
//
// This has to be conservative, because it is mounted in the ROOT LAYOUT and so
// runs on every rendered page. It used to forward on the bare presence of
// `code=` anywhere in the query, which silently broke /agent/statements: those
// links carry the INVESTOR code (`?code=A00005&type=transactions`), so every
// statement click bounced the agent to "this link is invalid or has expired".

// A recovery redirect that misses its redirect_to lands on the origin root or a
// login screen — never deep inside the app. Restricting the ambiguous `?code=`
// branch to these paths keeps business URLs that use `code` as an identifier
// (statements, investor lookups) working.
const LANDING_PATHS = new Set(["/", "/login", "/agent/login"]);

// Self-identifying Supabase artifacts. These never appear in our own URLs, so
// they are safe to honour on any path. Note `type=recovery|invite` is matched
// exactly — the statements links use `type=transactions`/`portfolio`/etc.
const AUTH_ARTIFACT =
  /access_token=|refresh_token=|type=recovery|type=invite|error_code=|error_description=/;

/**
 * A Supabase PKCE `code` is a long opaque token (UUID-like). Our own business
 * codes are short (`A00005`, `EFUF`), so length is a reliable discriminator.
 */
function looksLikeAuthCode(value: string | null): boolean {
  return !!value && value.length >= 20 && /^[A-Za-z0-9._~-]+$/.test(value);
}

export default function RecoveryHashRedirect() {
  useEffect(() => {
    const { hash, search, pathname } = window.location;
    if (pathname.startsWith("/agent/set-password")) return;

    if (AUTH_ARTIFACT.test(`${hash}${search}`)) {
      window.location.replace(`/agent/set-password${search}${hash}`);
      return;
    }

    // Ambiguous case: `?code=` is also how we pass investor codes. Only treat it
    // as PKCE when it has the shape of an auth code AND we are on a page a stray
    // auth redirect could plausibly have landed on.
    if (LANDING_PATHS.has(pathname)) {
      const code = new URLSearchParams(search).get("code");
      if (looksLikeAuthCode(code)) {
        window.location.replace(`/agent/set-password${search}${hash}`);
      }
    }
  }, []);
  return null;
}
