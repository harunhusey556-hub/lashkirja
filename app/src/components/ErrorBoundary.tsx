"use client";

import React, { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="glass p-6 rounded-2xl w-full border border-danger/20 bg-danger/5 animate-in flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 bg-danger/10 text-danger rounded-full flex items-center justify-center mb-4">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-charcoal mb-1">Osa sisällöstä ei voitu ladata</h3>
          <p className="text-xs text-warm-gray max-w-sm">
            {/* Never show the raw JS error message to the user (may contain
                stack details); it is already logged via componentDidCatch. */}
            Tapahtui odottamaton virhe. Yritä päivittää sivu.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 min-h-11 px-4 bg-white text-xs font-medium text-charcoal rounded-xl border border-warm-gray-light hover:bg-blush/30 transition-colors"
          >
            Yritä uudelleen
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
