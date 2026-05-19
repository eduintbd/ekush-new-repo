"use client";

// Reusable submit button for server-action forms. Uses useFormStatus so
// the button auto-disables and swaps its label to a pending state the
// instant the form is posted. This is the project-wide guard against
// "user clicks 'Save' three times → three identical batches get created".
//
// Drop it in as the *only* submit button inside a <form action={…}>:
//
//   <form action={createThing}>
//     …fields…
//     <SubmitButton>Save</SubmitButton>
//   </form>
//
// Customise the pending state via `pendingLabel`. Pass `disabled` to gate
// on additional client-side validation (e.g. "Σ debit must equal Σ credit").
// Variants follow the existing zinc/red palette used across the app.

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

type Variant = "primary" | "danger" | "ghost";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
  danger:
    "bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600",
  ghost:
    "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
};

export function SubmitButton({
  children,
  pendingLabel,
  disabled = false,
  variant = "primary",
  size = "md",
  fullWidth = false,
  className = "",
  formAction,
  name,
  value,
  confirm,
}: {
  children: ReactNode;
  pendingLabel?: ReactNode;
  disabled?: boolean;
  variant?: Variant;
  size?: "sm" | "md";
  fullWidth?: boolean;
  className?: string;
  /** Lets a single form host multiple buttons (e.g. Save vs. Save+Print). */
  formAction?: (formData: FormData) => void | Promise<void>;
  name?: string;
  value?: string;
  /** If set, prompt the user with window.confirm before submitting. */
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  const sizeCls = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-2 text-sm";
  const widthCls = fullWidth ? "w-full" : "";
  return (
    <button
      type="submit"
      formAction={formAction}
      name={name}
      value={value}
      disabled={disabled || pending}
      aria-busy={pending}
      data-unguarded="true"
      onClick={(e) => {
        if (pending) {
          // Defence in depth — the `disabled` attribute already blocks
          // submits, but if the browser fires a stray click while the
          // server action is in flight, this stops it too.
          e.preventDefault();
          return;
        }
        if (confirm && !window.confirm(confirm)) {
          e.preventDefault();
        }
      }}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${sizeCls} ${widthCls} ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {pending && <Spinner />}
      <span>{pending ? (pendingLabel ?? "Saving…") : children}</span>
    </button>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 animate-spin"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
