import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Tilikirja — Kirjanpito",
  description: "Yksinkertainen kirjanpito yrittäjille",
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
