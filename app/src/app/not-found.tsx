import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-cream px-4 flex items-center justify-center">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-6 text-center">
        <h1 className="text-xl font-medium text-charcoal">Sivua ei löytynyt</h1>
        <p className="mt-2 text-sm text-warm-gray">
          Osoite on virheellinen tai sivu on poistettu.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 min-h-11 px-4 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors inline-flex items-center justify-center"
        >
          Palaa etusivulle
        </Link>
      </div>
    </main>
  );
}
