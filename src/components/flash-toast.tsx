"use client";

// Global toast for flash messages set by server actions via flashRedirect.
// Reads ?flash=… (and ?fkind=success|error|info) from the URL on every
// navigation, shows a bottom-right card, auto-dismisses after 6 s, then
// strips the params so a reload doesn't re-show the message.
//
// Mounted once in app/layout.tsx and renders nothing when no flash is
// present — safe to leave on every page.

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const FLASH = "flash";
const FKIND = "fkind";

const STYLES: Record<string, string> = {
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  error:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
  info:
    "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100",
};

const BADGE_STYLES: Record<string, string> = {
  success: "bg-emerald-600 text-white",
  error: "bg-red-600 text-white",
  info: "bg-sky-600 text-white",
};

const BADGE_GLYPH: Record<string, string> = {
  success: "✓",
  error: "!",
  info: "i",
};

export function FlashToast() {
  // Wrap in Suspense so useSearchParams doesn't opt every page in the
  // app into client rendering during build.
  return (
    <Suspense fallback={null}>
      <FlashToastInner />
    </Suspense>
  );
}

function FlashToastInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Three accepted sources, in priority order: explicit ?flash (preferred),
  // then the legacy ?ok / ?error pattern already used by most existing
  // server-action redirects across the codebase.
  let message = searchParams.get(FLASH);
  let kind: "success" | "error" | "info" =
    searchParams.get(FKIND) === "error"
      ? "error"
      : searchParams.get(FKIND) === "info"
        ? "info"
        : "success";
  let usedKeys: string[] = [];

  if (message) {
    usedKeys = [FLASH, FKIND];
  } else if (searchParams.get("error")) {
    message = searchParams.get("error");
    kind = "error";
    usedKeys = ["error"];
  } else if (searchParams.get("ok")) {
    message = searchParams.get("ok");
    kind = "success";
    usedKeys = ["ok"];
  }

  // `visible` lets the user dismiss before the timer fires. Re-derived
  // whenever a new flash message appears in the URL.
  const [visible, setVisible] = useState<boolean>(Boolean(message));

  const usedKeysFingerprint = usedKeys.join(",");

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      stripFlash(router, pathname, searchParams, usedKeysFingerprint.split(",").filter(Boolean));
    }, 6000);
    return () => clearTimeout(t);
  }, [message, kind, router, pathname, searchParams, usedKeysFingerprint]);

  if (!message || !visible) return null;

  const dismiss = () => {
    setVisible(false);
    stripFlash(router, pathname, searchParams, usedKeys);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`no-print fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border p-4 shadow-lg ${STYLES[kind]}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${BADGE_STYLES[kind]}`}
        >
          {BADGE_GLYPH[kind]}
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-line text-sm">{message}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-m-1 rounded p-1 opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function stripFlash(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: URLSearchParams,
  keys: string[],
) {
  const params = new URLSearchParams(searchParams.toString());
  for (const k of keys) params.delete(k);
  const qs = params.toString();
  router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
}
