"use client";

import React, { Component, ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { buttonClass } from "@/components/control-styles";
import { Icon } from "@/components/ds/Icon";

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
        <div className="p-6 rounded-card w-full border border-danger/20 bg-danger/5 animate-in flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 bg-danger/10 text-danger rounded-full flex items-center justify-center mb-4">
            <Icon icon={TriangleAlert} size="tab" />
          </div>
          <h3 className="text-sm font-semibold text-ink mb-1">Osa sisällöstä ei voitu ladata</h3>
          <p className="text-xs text-ink-2 max-w-sm">
            {/* Never show the raw JS error message to the user (may contain
                stack details); it is already logged via componentDidCatch. */}
            Tapahtui odottamaton virhe. Yritä päivittää sivu.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className={`mt-4 ${buttonClass("secondary")}`}
          >
            Yritä uudelleen
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
