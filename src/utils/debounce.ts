/**
 * Debounces an async function on the leading edge: the first call runs
 * immediately, subsequent calls during the wait window are coalesced and
 * resolve with the result of a single trailing invocation using the most
 * recent arguments.
 */
export function debounceLeading<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  waitMs: number,
): (...args: Args) => Promise<R> {
  let timer: NodeJS.Timeout | undefined;
  let lastRun = 0;
  let pending: { args: Args; resolvers: Array<{ resolve: (r: R) => void; reject: (e: unknown) => void }> } | undefined;

  const flush = () => {
    const batch = pending;
    pending = undefined;
    timer = undefined;
    if (!batch) {
      return;
    }
    lastRun = Date.now();
    fn(...batch.args).then(
      result => batch.resolvers.forEach(r => r.resolve(result)),
      error => batch.resolvers.forEach(r => r.reject(error)),
    );
  };

  return (...args: Args): Promise<R> => {
    const now = Date.now();
    if (!timer && now - lastRun >= waitMs) {
      // Leading edge: run immediately, then open a quiet window.
      lastRun = now;
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) {
          flush();
        }
      }, waitMs);
      return fn(...args);
    }
    // Within the window: coalesce into one trailing call with latest args.
    return new Promise<R>((resolve, reject) => {
      if (pending) {
        pending.args = args;
        pending.resolvers.push({ resolve, reject });
      } else {
        pending = { args, resolvers: [{ resolve, reject }] };
      }
      if (!timer) {
        timer = setTimeout(flush, waitMs);
      }
    });
  };
}
