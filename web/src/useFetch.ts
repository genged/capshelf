import { useEffect, useState } from "react";

/**
 * Fetch-once hook with an unmount guard, so a slow response that resolves
 * after the user navigates away can't setState on an unmounted component.
 */
export function useFetch<T>(fn: () => Promise<T>): {
  data: T | null;
  error: string | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fn()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
    // fn is a stable per-screen call; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, error };
}
