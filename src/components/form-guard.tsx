"use client";

// Global form safety net. Mounted once in app/layout.tsx, it attaches a
// single capture-phase `submit` listener to the document and, on every
// form submission anywhere in the app:
//
//   1. If the form carries `data-confirm="…"`, prompt the user with
//      window.confirm() and cancel the submit if they say no.
//   2. Disable every submit button / input[type=submit] inside the form
//      so a fast double click can't post the same form twice.
//   3. Swap the button label to "Saving…" (or the value of
//      `data-pending-label="…"` on the form or button) and show a small
//      inline spinner. The original innerHTML / value is stashed on the
//      button so it can be restored once the server action completes.
//
// This works for plain HTML forms, RSC server-action forms, and
// progressively-enhanced forms alike — no per-page changes required.
//
// Restoring after completion: when a server action calls redirect(),
// the URL changes — `usePathname` / `useSearchParams` will fire and we
// wipe the pending state off every guarded button. Direct DOM mutation
// would otherwise survive React's reconciliation (the vDOM didn't see
// the innerHTML change), which left buttons stuck on "Saving…" forever
// even after the success toast appeared.

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const SAVING = "Saving…";

export function FormGuard() {
  const pathname = usePathname();
  const searchParamsString = useSearchParams().toString();

  // Restore any guarded buttons whenever the URL changes — i.e. the
  // server action redirected (the common case). Detached from the
  // submit handler so it always runs even if the form unmounted, and
  // re-runs idempotently across any back/forward navigation. Using
  // searchParams.toString() (not the object itself) so the dep is a
  // stable string and the effect only re-runs on real URL changes.
  useEffect(() => {
    const guarded = document.querySelectorAll<HTMLElement>(
      "[data-form-guard-original-html], [data-form-guard-original-value]",
    );
    guarded.forEach((el) => {
      if (el instanceof HTMLButtonElement && el.dataset.formGuardOriginalHtml !== undefined) {
        el.innerHTML = el.dataset.formGuardOriginalHtml;
        delete el.dataset.formGuardOriginalHtml;
      } else if (el instanceof HTMLInputElement && el.dataset.formGuardOriginalValue !== undefined) {
        el.value = el.dataset.formGuardOriginalValue;
        delete el.dataset.formGuardOriginalValue;
      }
      el.removeAttribute("disabled");
      el.removeAttribute("aria-busy");
    });
  }, [pathname, searchParamsString]);

  useEffect(() => {
    const handle = (e: Event) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || !(form instanceof HTMLFormElement)) return;

      const confirmMsg = form.dataset.confirm;
      if (confirmMsg && !window.confirm(confirmMsg)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      const buttons = form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button[type="submit"], button:not([type]), input[type="submit"]',
      );
      buttons.forEach((b) => {
        // Skip buttons explicitly opted out (rare — e.g. multi-button forms
        // where only one should be guarded).
        if (b.dataset.unguarded === "true") return;

        b.disabled = true;
        b.setAttribute("aria-busy", "true");

        const formPending = form.dataset.pendingLabel;
        const btnPending = (b as HTMLButtonElement).dataset?.pendingLabel;
        const pendingLabel = btnPending || formPending || SAVING;

        if (b instanceof HTMLButtonElement) {
          if (b.dataset.formGuardOriginalHtml === undefined) {
            b.dataset.formGuardOriginalHtml = b.innerHTML;
          }
          b.innerHTML = `<span class="inline-flex items-center gap-1.5"><svg aria-hidden viewBox="0 0 24 24" class="h-3.5 w-3.5 animate-spin" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"></circle><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path></svg><span>${escapeHtml(pendingLabel)}</span></span>`;
        } else if (b instanceof HTMLInputElement) {
          if (b.dataset.formGuardOriginalValue === undefined) {
            b.dataset.formGuardOriginalValue = b.value;
          }
          b.value = pendingLabel;
        }
      });
    };

    document.addEventListener("submit", handle, true);
    return () => document.removeEventListener("submit", handle, true);
  }, []);

  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
