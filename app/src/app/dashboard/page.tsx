import { Suspense } from "react";
import DashboardClient, { KotiFallback } from "./DashboardClient";

// No `cookies()`/`getSession()` here on purpose: this page prerenders at
// build time in the mobile static export (see static-exports.md,
// "Unsupported Features" -- dynamic server functions are unsupported).
// DashboardClient sources firstName itself; see its own comment.
// The Suspense boundary is for the month in the address (`?month=`, F25): a
// static page may read search params on the client only inside one.
export default function DashboardPage() {
  return (
    <Suspense fallback={<KotiFallback />}>
      <DashboardClient />
    </Suspense>
  );
}
