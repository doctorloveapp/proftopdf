import type { Metadata, Viewport } from "next";
import { APP_NAME, PRODUCTION_ORIGIN } from "@/lib/shared/constants";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCTION_ORIGIN),
  title: `${APP_NAME} — La lezione diventa appunti`,
  description:
    "Le tue lezioni universitarie, organizzate in appunti chiari e PDF da studiare.",
  applicationName: APP_NAME,
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f9fc",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
