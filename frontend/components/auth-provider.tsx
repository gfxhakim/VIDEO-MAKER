"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, type User } from "@/lib/api";

type AuthCtx = { user: User | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> };
const Ctx = createContext<AuthCtx>({ user: null, loading: true, refresh: async () => {}, signOut: async () => {} });

export const useAuth = () => useContext(Ctx);

/** Client-side guard: every page except /signin needs a session. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const path = usePathname();
  const onSignin = path?.startsWith("/signin");

  const refresh = useCallback(async () => {
    try {
      const st = await api.authStatus();
      setUser(st.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    if (!user && !onSignin) router.replace("/signin");
    if (user && onSignin) router.replace("/");
  }, [loading, user, onSignin, router]);

  const signOut = useCallback(async () => {
    await api.signout().catch(() => {});
    setUser(null);
    router.replace("/signin");
  }, [router]);

  return <Ctx.Provider value={{ user, loading, refresh, signOut }}>{children}</Ctx.Provider>;
}
