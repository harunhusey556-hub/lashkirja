import BootRedirect from "@/components/BootRedirect";

// No `cookies()`/`getSession()` here on purpose: this page prerenders at
// build time in the mobile static export, where dynamic server functions
// are unsupported (see static-exports.md, "Unsupported Features"). All the
// real routing decisions happen in BootRedirect (client-side) and, on the
// web, already one step earlier in proxy.ts.
export default function Home() {
  return <BootRedirect />;
}
