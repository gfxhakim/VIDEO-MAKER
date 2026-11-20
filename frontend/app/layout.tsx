import type { Metadata, Viewport } from "next";
import { Anton, Bebas_Neue, DM_Serif_Display, Inter, Montserrat, Poppins } from "next/font/google";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth-provider";
import { MotionSettings } from "@/components/ui/motion-settings";
import { UploadProvider } from "@/components/upload-provider";
import "./globals.css";

// The interface font: the only one that is preloaded on every page.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
// Caption fonts, so the style picker previews look like the real render. They are only needed where
// a caption preview is on screen, so they are not preloaded: the browser fetches each file the
// first time some text actually uses it.
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], weight: ["600", "800", "900"], style: ["normal", "italic"], display: "swap", preload: false });
const anton = Anton({ variable: "--font-anton", subsets: ["latin"], weight: "400", display: "swap", preload: false });
const bebas = Bebas_Neue({ variable: "--font-bebas", subsets: ["latin"], weight: "400", display: "swap", preload: false });
const dmSerif = DM_Serif_Display({ variable: "--font-dmserif", subsets: ["latin"], weight: "400", display: "swap", preload: false });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["600", "700", "800"], display: "swap", preload: false });

export const metadata: Metadata = {
  title: "AutoClip Studio",
  description: "Turn long videos into viral vertical clips.",
};

// viewportFit "cover" lets the app paint under the notch and the home indicator; the shell, the
// dialogs and the clip studio keep their controls clear of them with env(safe-area-inset-*).
export const viewport: Viewport = { themeColor: "#121218", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

// The static export serves /signin/ (with the slash); `next dev` serves /signin.
const SIGNIN_PATH = process.env.NODE_ENV === "production" ? "/signin/" : "/signin";

/**
 * Runs while the HTML is still being read, long before the app's JavaScript has arrived: it asks
 * the server who is here, so the answer is usually waiting when the app starts (no spinner, no
 * extra round trip). Until the app runs it also does the two redirects itself: signed-out visitors
 * go straight to the sign-in page, signed-in ones skip it. components/auth-provider.tsx picks up
 * `__acAuth` and sets `__acReady`; the storage key and its JSON shape must match that file.
 */
const EARLY_AUTH = `(function(){try{var w=window,K="autoclip:user",S=${JSON.stringify(SIGNIN_PATH)},on=/^\\/signin\\/?$/.test(location.pathname);var p=fetch("/api/auth/status",{credentials:"include",headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("status "+r.status);return r.json()}).then(function(s){var u=s&&s.user;try{u?localStorage.setItem(K,JSON.stringify({id:u.id,email:u.email,name:u.name,role:u.role||"user"})):localStorage.removeItem(K)}catch(e){}if(!w.__acReady){if(!u&&!on)location.replace(S);else if(u&&on)location.replace("/")}return s});p.catch(function(){});w.__acAuth=p}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${montserrat.variable} ${anton.variable} ${bebas.variable} ${dmSerif.variable} ${poppins.variable} font-sans`}>
        <script dangerouslySetInnerHTML={{ __html: EARLY_AUTH }} />
        <MotionSettings>
          <AuthProvider>
            <UploadProvider>
              <AppShell>{children}</AppShell>
            </UploadProvider>
          </AuthProvider>
        </MotionSettings>
        <Toaster theme="dark" richColors position="top-center" />
      </body>
    </html>
  );
}
