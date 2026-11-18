"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, type AuthStatus, type User } from "@/lib/api";

type AuthCtx = {
  user: User | null;
  /** True until we know who is here: from this browser's memory of the last session, or from the server. */
  loading: boolean;
  /** The server's last answer to "who am I" (also says if sign-up is open). Null until it has answered. */
  status: AuthStatus | null;
  /** Ask the server again. Never throws. */
  refresh: () => Promise<void>;
  /** After a successful sign-in or sign-up: take the returned user, no second round trip needed. */
  login: (user: User) => void;
  signOut: () => Promise<void>;
};
const Ctx = createContext<AuthCtx>({ user: null, loading: true, status: null, refresh: async () => {}, login: () => {}, signOut: async () => {} });

export const useAuth = () => useContext(Ctx);

/** Who was signed in on this browser last time (id, name and email only). Lets a returning user see
 *  the app at once while the server check runs. It grants nothing: every API call still needs the
 *  session cookie. Keep the key in sync with the early script in app/layout.tsx. */
const HINT_KEY = "autoclip:user";

type EarlyWindow = Window & {
  /** The status request that app/layout.tsx starts before any script has loaded. */
  __acAuth?: Promise<AuthStatus> | null;
  /** Set once React runs: from then on redirects are ours, not the early script's. */
  __acReady?: boolean;
};

function readHint(): User | null {
  try {
    const u = JSON.parse(localStorage.getItem(HINT_KEY) || "null");
    return u && typeof u.id === "number" && typeof u.email === "string" ? { id: u.id, email: u.email, name: typeof u.name === "string" ? u.name : "" } : null;
  } catch {
    return null;
  }
}
function remember(u: User | null) {
  try {
    if (u) localStorage.setItem(HINT_KEY, JSON.stringify({ id: u.id, email: u.email, name: u.name }));
    else localStorage.removeItem(HINT_KEY);
  } catch {}
}
const sameUser = (a: User | null, b: User | null) => a === b || (!!a && !!b && a.id === b.id && a.email === b.email && a.name === b.name);

/** Client-side guard: every page except /signin needs a session. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false); // the server has answered (or a sign-in just succeeded)
  const router = useRouter();
  const path = usePathname();
  const onSignin = !!path?.startsWith("/signin");
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; tries: number }>({ timer: null, tries: 0 });
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const apply = useCallback((st: AuthStatus) => {
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current = { timer: null, tries: 0 };
    setStatus(st);
    setUser((prev) => (sameUser(prev, st.user) ? prev : st.user));
    remember(st.user);
    setVerified(true);
    setLoading(false);
  }, []);

  /** The server could not be reached. Nobody is signed out because of a bad connection: keep what we
   *  have and ask again quietly, a little slower each time. */
  const failed = useCallback(() => {
    setLoading(false);
    const r = retry.current;
    if (r.timer) clearTimeout(r.timer);
    r.tries += 1;
    r.timer = setTimeout(() => void refreshRef.current(), Math.min(30000, 2500 * r.tries));
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.authStatus());
    } catch {
      failed();
    }
  }, [apply, failed]);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // First load. The status request was already started by the script in app/layout.tsx, long before
  // this code arrived; a returning user is shown the app right away from the remembered session.
  useEffect(() => {
    const w = window as EarlyWindow;
    w.__acReady = true;
    if (!window.location.pathname.startsWith("/signin")) {
      const hint = readHint();
      if (hint) {
        setUser(hint);
        setLoading(false);
      }
    }
    const early = w.__acAuth;
    w.__acAuth = null;
    if (early) early.then(apply, () => void refreshRef.current());
    else void refreshRef.current();

    const online = () => {
      if (retry.current.timer) void refreshRef.current();
    };
    // signing in or out in another tab of this browser
    const storage = (e: StorageEvent) => {
      if (e.key === HINT_KEY || e.key === null) void refreshRef.current();
    };
    window.addEventListener("online", online);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("storage", storage);
      if (retry.current.timer) clearTimeout(retry.current.timer);
      retry.current.timer = null;
    };
  }, [apply]);

  useEffect(() => {
    if (loading) return;
    if (!user && !onSignin) router.replace("/signin");
    // only a session the server confirmed may leave the sign-in page
    if (user && verified && onSignin) router.replace("/");
  }, [loading, user, verified, onSignin, router]);

  const login = useCallback((u: User) => {
    remember(u);
    setUser(u);
    setStatus((s) => (s ? { ...s, needs_setup: false, user: u } : s));
    setVerified(true);
    setLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    await api.signout().catch(() => {});
    remember(null);
    setUser(null);
    setStatus((s) => (s ? { ...s, user: null } : s));
    setVerified(true);
    router.replace("/signin");
  }, [router]);

  const value = useMemo(() => ({ user, loading, status, refresh, login, signOut }), [user, loading, status, refresh, login, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
