// Legacy path for the onboarding upload authoriser, kept so a browser tab left
// open on the old page keeps working after the route moved to the shared
// /api/agent/kyc/upload-url. Delegates; holds no logic of its own.
//
// runtime and preferredRegion are declared literally rather than re-exported:
// Next reads these at build time by static analysis and silently ignores a
// re-exported binding, which would have quietly run this copy on the default
// runtime in the default region instead of Node in Tokyo.
//
// Safe to delete once no client has been served the old bundle for a while.

export { POST } from "@/app/api/agent/kyc/upload-url/route";

export const runtime = "nodejs";
export const preferredRegion = "hnd1";
