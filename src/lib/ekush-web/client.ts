// Ekush Web API client. Real fetch when EKUSH_WEB_API_BASE is set;
// otherwise falls back to the deterministic mock fixtures.
//
// Per spec §7 implementation rules:
// - Server-side only (service token must not leak to the browser).
// - 5-minute cache per agent_code.
// - Manual refresh via the cache: 'no-store' overload.

import type { EkushWebInvestor } from "./types";
import { mockInvestorsForAgent } from "./mock";

export type FetchOptions = { bypassCache?: boolean };

export async function fetchInvestorsForAgent(
  agentCode: string,
  opts: FetchOptions = {},
): Promise<EkushWebInvestor[]> {
  const base = process.env.EKUSH_WEB_API_BASE;
  const token = process.env.EKUSH_WEB_API_TOKEN;

  if (!base || !token) {
    return mockInvestorsForAgent(agentCode);
  }

  const url = `${base.replace(/\/$/, "")}/api/v1/investors?agent_code=${encodeURIComponent(agentCode)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: opts.bypassCache ? "no-store" : "force-cache",
    next: opts.bypassCache ? undefined : { revalidate: 300, tags: [`ekush-web:agent:${agentCode}`] },
  });
  if (!res.ok) {
    throw new Error(`Ekush Web returned ${res.status} for agent ${agentCode}`);
  }
  return (await res.json()) as EkushWebInvestor[];
}
