// Password policy — matches the portal's rules so agents face the same bar:
//   min 10 chars · at least one upper, lower, digit, symbol
export function validatePassword(
  pwd: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof pwd !== "string") return { ok: false, reason: "Password is required." };
  if (pwd.length < 10) return { ok: false, reason: "Password must be at least 10 characters." };
  if (!/[A-Z]/.test(pwd)) return { ok: false, reason: "Password must contain an uppercase letter." };
  if (!/[a-z]/.test(pwd)) return { ok: false, reason: "Password must contain a lowercase letter." };
  if (!/\d/.test(pwd)) return { ok: false, reason: "Password must contain a digit." };
  if (!/[^A-Za-z0-9]/.test(pwd)) return { ok: false, reason: "Password must contain a symbol." };
  return { ok: true };
}
