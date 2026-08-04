// /agent/calculator — commission calculator. The agent enters an amount and a
// tenor, picks a fund, and sees the upfront + trail commission they would earn,
// based on the fund's real CAGR (from its NAV history) and the agent's own
// commission rates. A chart shows how the commission builds up over the tenor.
//
// The maths is pure and runs live in the browser (CalculatorClient); this
// server component just loads the fund CAGR/NAV and the agent's rates.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { getFundsWithCagr } from "@/lib/portal-funds";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import { getAgentBookShortfall, makeRateResolver } from "@/lib/upfront-watermark";
import CalculatorClient, { type CalcFund } from "./CalculatorClient";

export const dynamic = "force-dynamic";

export default async function AgentCalculatorPage() {
  const scope = await getAgentScope();

  // The agent's own active rates, by fund category.
  const terms = scope.agentId
    ? await prisma.agentTerm.findMany({
        where: { agentId: scope.agentId },
        orderBy: { effectiveFrom: "desc" },
      })
    : [];
  const today = new Date();

  // The upfront rate comes from the same resolver the posting run uses, so the
  // calculator cannot quote a rate the office would not pay.
  const upfrontResolver = makeRateResolver(
    terms.map((t) => ({
      fundCategory: t.fundCategory,
      upfrontPct: Number(t.upfrontPct),
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
    })),
    today,
  );
  const trailFor = (category: "equity" | "fixed_income") => {
    const t = terms.find(
      (x) =>
        x.fundCategory === category &&
        x.effectiveFrom <= today &&
        (x.effectiveTo === null || x.effectiveTo > today),
    );
    return {
      trailY1: t ? Number(t.trailY1PctPa) : 0,
      trailY2: t ? Number(t.trailY2PlusPctPa) : 0,
    };
  };

  // How far this agent's book sits below its peak. New money only earns upfront
  // above that line; without this the calculator promises upfront on money that
  // is merely replacing earlier redemptions.
  const shortfall = scope.agentId
    ? await getAgentBookShortfall(prisma, scope.agentId, today).catch(() => null)
    : null;

  const funds = await getFundsWithCagr().catch(() => []);
  const calcFunds: CalcFund[] = funds.map((f) => {
    const category = categoryForFund(f.code as FundCode);
    const r = trailFor(category);
    return {
      code: f.code,
      name: f.name,
      category,
      cagr: f.cagr,
      cagrYears: f.cagrYears,
      currentNav: f.currentNav,
      upfrontRate: upfrontResolver(f.code)?.rate ?? 0,
      trailY1Rate: r.trailY1,
      trailY2Rate: r.trailY2,
    };
  });

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Commission calculator</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            See what you would earn by bringing an investor — upfront and monthly trail —
            using each fund&apos;s real performance and your own rates.
          </p>
        </div>

        {calcFunds.length === 0 ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Fund data isn&apos;t available right now. Try again shortly.
          </p>
        ) : (
          <CalculatorClient funds={calcFunds} bookShortfall={shortfall?.shortfall ?? 0} />
        )}
      </div>
    </main>
  );
}
