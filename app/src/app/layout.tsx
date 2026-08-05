import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LashKirja",
  description: "Yksinkertainen kirjanpito",
  manifest: "/manifest.json",
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
  themeColor: "#F9E4E4",
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
