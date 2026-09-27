/** What the bank tab should lead with. A live link wins over a manual account. */
export function bankHomeLead(liveConnections: number): "accounts" | "connect" {
  return liveConnections > 0 ? "accounts" : "connect";
}
