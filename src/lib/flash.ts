// Tiny helper that lets server actions return a flash message to the
// destination page via the URL. The <FlashToast> component, mounted in
// the root layout, reads these params on every navigation and pops a
// toast. Using the URL (instead of a cookie) keeps server actions pure
// and works the same in dev, prod, and edge runtimes.
//
//   import { flashRedirect } from "@/lib/flash";
//   …
//   await prisma.thing.create({ data });
//   flashRedirect("/things", "Thing created", "success");
//
// kind defaults to "success"; pass "error" for the red variant. The
// message is appended to the path as `?flash=<msg>&fkind=<kind>` and
// merged with any existing query string already on the path.

import { redirect } from "next/navigation";

export type FlashKind = "success" | "error" | "info";

export const FLASH_PARAM = "flash";
export const FLASH_KIND_PARAM = "fkind";

export function flashUrl(path: string, message: string, kind: FlashKind = "success"): string {
  const [base, existing] = path.split("?", 2);
  const params = new URLSearchParams(existing ?? "");
  params.set(FLASH_PARAM, message);
  params.set(FLASH_KIND_PARAM, kind);
  return `${base}?${params.toString()}`;
}

export function flashRedirect(path: string, message: string, kind: FlashKind = "success"): never {
  redirect(flashUrl(path, message, kind));
}
