import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LashKirja",
  description: "Yksinkertainen kirjanpito",
  manifest: "/manifest.json",
  // iOS ignores the manifest icons and only reads apple-touch-icon, so the
  // home-screen icon has to be declared here as well or Safari falls back to a
  // screenshot of the page.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LashKirja",
  },
};

// viewportFit: "cover" is what makes env(safe-area-inset-*) resolve to real
// values. globals.css already pads .app-header / .app-tab-bar / .app-main with
// those insets, but without this they all fall back to 0px and the tab bar
// collides with the iPhone home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5e6e0",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fi">
      <body className={`${inter.className} bg-cream min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
