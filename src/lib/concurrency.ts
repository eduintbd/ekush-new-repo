// Bounded-concurrency map, used where a route has a handful of independent
// network calls to make and running them one after another is the whole cost.
//
// First adopted by /api/agent/investors/create, which uploads up to nine KYC
// files. The other sequential upload loops — admin/agents/[id]/documents,
// agent/purchase, agent/sip/bank — can adopt it unchanged when someone gets to
// them; that is why this lives here rather than inline in the route.

export type Settled<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown };

/**
 * Run `fn` over `items`, at most `limit` in flight, preserving input order.
 *
 * Deliberately SETTLES every item instead of rejecting on the first failure.
 * `Promise.all` hands back whichever promise rejected EARLIEST IN TIME, and for
 * network work that is arbitrary — the same nine files could report a different
 * error on every run depending on which upload happened to lose. Callers
 * replacing a sequential `for` loop need the failure with the lowest INDEX,
 * because that is what the loop they are replacing returned. So this returns a
 * positional array and lets the caller scan front-to-back and decide.
 *
 * Passing `limit = 1` reproduces a plain sequential loop exactly, which makes
 * it both a kill switch and the oracle the tests compare against.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const results = new Array<Settled<R>>(items.length);
  let next = 0;

  // No lock needed: there is no await between reading and incrementing `next`,
  // and JS is single-threaded, so two workers can never claim the same index.
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };

  // A worker never rejects, so this Promise.all cannot short-circuit: every
  // item settles, nothing is abandoned in flight, and a late failure can never
  // surface as an unhandled rejection after the caller has already answered.
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
