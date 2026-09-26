"use client";

import { useEffect } from "react";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("Sivun odottamaton virhe", error);
  }, [error]);

  return (
    <main className="min-h-screen bg-blush px-4 flex items-center justify-center relative overflow-hidden">
      {/* Decorative background shapes */}
      <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-cream rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-pulse motion-reduce:animate-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-rose rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-pulse motion-reduce:animate-none" style={{ animationDelay: '2s' }}></div>
      
      <div className="w-full max-w-sm glass rounded-2xl p-8 text-center animate-in relative z-10">
        <div className="w-16 h-16 mx-auto bg-charcoal/5 rounded-full flex items-center justify-center mb-6">
          <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-charcoal mb-2">Jokin meni pieleen</h1>
        <p className="text-sm text-warm-gray mb-8">
          Sivua ei voitu näyttää. Yritä hetken kuluttua uudelleen.
        </p>
        <button
          type="button"
          onClick={unstable_retry}
          className="w-full h-12 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-all hover-lift active:scale-95"
        >
          Yritä uudelleen
        </button>
      </div>
    </main>
  );
}
