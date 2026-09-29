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
        <div
          role="alert"
          className="flex w-full flex-col items-center justify-center rounded-card border border-danger/30 bg-danger/10 p-4 text-center"
        >
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-danger/10 text-danger">
            <Icon icon={TriangleAlert} size="hero" />
          </div>
          <h3 className="text-headline font-semibold text-ink">Jotain meni pieleen</h3>
          <p className="mt-1 max-w-sm text-body text-ink-2">
            {/* Never show the raw JS error message to the user (may contain
                stack details); it is already logged via componentDidCatch. */}
            Osaa sisällöstä ei voitu näyttää. Yritä uudelleen.
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
