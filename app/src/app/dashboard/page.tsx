import DashboardClient from "./DashboardClient";

// No `cookies()`/`getSession()` here on purpose: this page prerenders at
// build time in the mobile static export (see static-exports.md,
// "Unsupported Features" -- dynamic server functions are unsupported).
// DashboardClient sources firstName itself; see its own comment.
export default function DashboardPage() {
  return <DashboardClient />;
}
