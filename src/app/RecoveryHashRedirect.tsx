"use client";

import { useEffect } from "react";

// Supabase sometimes lands a recovery/invite redirect on the site root (with the
// session tokens or an error in the URL hash) rather than the redirect_to path.
// If we detect that on any page that mounts this, forward to /agent/set-password
// carrying the hash + query so the set-password flow can handle it.
export default function RecoveryHashRedirect() {
  useEffect(() => {
    const hash = window.location.hash ?? "";
    const search = window.location.search ?? "";
    const blob = `${hash}${search}`;
    const looksLikeRecovery =
      /access_token=|refresh_token=|type=recovery|type=invite|error_code=|error_description=|[?&]code=/.test(blob);
    if (looksLikeRecovery && !window.location.pathname.startsWith("/agent/set-password")) {
      window.location.replace(`/agent/set-password${search}${hash}`);
    }
  }, []);
  return null;
}
