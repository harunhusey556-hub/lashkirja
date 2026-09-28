import Link from "next/link";
import { buttonClass } from "@/components/control-styles";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-canvas px-4 flex items-center justify-center">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 text-center">
        <h1 className="text-xl font-medium text-ink">Sivua ei löytynyt</h1>
        <p className="mt-2 text-sm text-ink-2">
          Osoite on virheellinen tai sivu on poistettu.
        </p>
        <Link href="/dashboard" className={`mt-5 ${buttonClass("primary")}`}>
          Palaa etusivulle
        </Link>
      </div>
    </main>
  );
}
