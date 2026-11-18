import type { Metadata, Viewport } from "next";
import { Anton, Bebas_Neue, DM_Serif_Display, Inter, Montserrat, Poppins } from "next/font/google";
import { Toaster } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth-provider";
import { UploadProvider } from "@/components/upload-provider";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
// Caption fonts, so the style picker previews look like the real render.
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], weight: ["600", "800", "900"], style: ["normal", "italic"] });
const anton = Anton({ variable: "--font-anton", subsets: ["latin"], weight: "400" });
const bebas = Bebas_Neue({ variable: "--font-bebas", subsets: ["latin"], weight: "400" });
const dmSerif = DM_Serif_Display({ variable: "--font-dmserif", subsets: ["latin"], weight: "400" });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["600", "700", "800"] });

export const metadata: Metadata = {
  title: "AutoClip Studio",
  description: "Turn long videos into viral vertical clips.",
};

export const viewport: Viewport = { themeColor: "#121218", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${montserrat.variable} ${anton.variable} ${bebas.variable} ${dmSerif.variable} ${poppins.variable} font-sans`}>
        <AuthProvider>
          <UploadProvider>
            <AppShell>{children}</AppShell>
          </UploadProvider>
        </AuthProvider>
        <Toaster theme="dark" richColors position="top-center" />
      </body>
    </html>
  );
}
