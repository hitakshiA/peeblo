import { useCallback, useEffect, useState } from "react";
import { friendly, get } from "./api";

// Loads a value from the API and reloads on demand (or every `every` ms). Errors come back as one friendly line.
export function useLoad<T>(path: string | null, every = 0): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { if (path) get<T>(path).then((d) => { setData(d); setError(null); }, (e) => setError(friendly(e))); }, [path]);
  useEffect(() => { reload(); if (!every) return; const t = setInterval(reload, every); return () => clearInterval(t); }, [reload, every]);
  return { data, error, reload };
}
