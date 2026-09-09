// Proves the properties /api/agent/investors/create relies on when it swapped
// a sequential upload loop for mapWithConcurrency. No DB, no Supabase, no
// network — pure timing control, so it is safe to run anywhere.
//
//   npx tsx scripts/verify-upload-pool.ts
//
// The property that matters most is the timing inversion: the route must report
// the failure with the LOWEST INDEX, not the one that failed FIRST IN TIME.
// Get that wrong and an agent sees "Cheque leaf: …" for a broken NID photo,
// with the wrong HTTP status attached.

import { mapWithConcurrency, type Settled } from "../src/lib/concurrency";

// A late unhandled rejection would mean a worker abandoned in flight.
process.on("unhandledRejection", (e) => {
  console.error("FAIL — unhandled rejection:", e);
  process.exit(1);
});

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the route does: scan front-to-back, first failure by index wins. */
function firstFailureIndex(settled: Array<Settled<unknown>>): number {
  return settled.findIndex((r) => !r.ok);
}

async function main() {
  // 1. Timing inversion. Index 7 fails almost immediately; index 1 fails much
  //    later. Promise.all would surface 7. We must select 1. Repeated because
  //    a race that passes once proves nothing.
  {
    let wrong = 0;
    for (let run = 0; run < 50; run++) {
      const settled = await mapWithConcurrency(
        Array.from({ length: 9 }, (_, i) => i),
        3,
        async (i) => {
          if (i === 7) { await sleep(10); throw new Error("late-index fails fast"); }
          if (i === 1) { await sleep(200); throw new Error("early-index fails slow"); }
          await sleep(20);
          return `ok-${i}`;
        },
      );
      if (firstFailureIndex(settled) !== 1) wrong++;
    }
    check("timing inversion: lowest index wins over first-to-fail", wrong === 0, `${50 - wrong}/50 runs correct`);
  }

  // 2. Order preserved under randomised delays.
  {
    const n = 25;
    const settled = await mapWithConcurrency(
      Array.from({ length: n }, (_, i) => i),
      4,
      async (i) => { await sleep(Math.random() * 30); return i; },
    );
    const ordered = settled.every((r, i) => r.ok && r.value === i);
    check("results stay in input order under random delays", ordered);
  }

  // 3. Never more than `limit` in flight.
  {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++inFlight);
      await sleep(Math.random() * 15);
      inFlight--;
      return null;
    });
    check("concurrency never exceeds the limit", peak <= 3, `peak=${peak}, limit=3`);
  }

  // 4. Every index populated, even when everything throws.
  {
    const settled = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => { throw new Error("x"); });
    const complete = settled.length === 5 && settled.every((r) => r !== undefined && !r.ok);
    check("no undefined holes when every item fails", complete);
  }

  // 5. limit=1 is the oracle: identical to a plain sequential for-loop.
  {
    const items = [0, 1, 2, 3, 4, 5];
    const work = async (i: number) => { if (i === 3 || i === 5) throw new Error(`boom-${i}`); return i * 2; };

    const pooled = await mapWithConcurrency(items, 1, work);
    const loop: Array<Settled<number>> = [];
    for (const i of items) {
      try { loop.push({ ok: true, value: await work(i) }); }
      catch (error) { loop.push({ ok: false, error }); }
    }
    const same =
      pooled.length === loop.length &&
      pooled.every((r, i) => r.ok === loop[i].ok && (!r.ok || r.value === (loop[i] as { value: number }).value));
    check("limit=1 matches a sequential loop exactly", same);
  }

  // 6. Edges.
  {
    const empty = await mapWithConcurrency([], 3, async () => null);
    check("empty input returns empty, does not hang", empty.length === 0);

    const single = await mapWithConcurrency([42], 3, async (v) => v);
    check("limit greater than item count is clamped", single.length === 1 && single[0].ok);

    const zero = await mapWithConcurrency([1, 2], 0, async (v) => v);
    check("limit of 0 still makes progress (clamped to 1)", zero.length === 2 && zero.every((r) => r.ok));
  }

  // 7. A non-Error thrown value survives intact — the route type-checks with
  //    `instanceof KycUploadError`, so the identity of what was thrown matters.
  {
    const sentinel = { status: 413, message: "not an Error instance" };
    const settled = await mapWithConcurrency([1], 1, async () => { throw sentinel; });
    check("thrown value is passed through by identity", !settled[0].ok && settled[0].error === sentinel);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
