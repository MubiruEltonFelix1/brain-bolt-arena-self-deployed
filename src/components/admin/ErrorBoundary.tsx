import { ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";

type ErrorBoundaryState = { hasError: boolean; error: Error | null };

export function ErrorBoundary({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: (props: { error: Error; reset: () => void }) => React.ReactNode;
}) {
  const [state, setState] = useState<ErrorBoundaryState>({
    hasError: false,
    error: null,
  });

  if (state.hasError) {
    const DefaultFallback = ({ error, reset }: { error: Error; reset: () => void }) => (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-6">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-md border border-border bg-background/50 mb-4">
          <span className="size-8 text-pink-shock">⚠</span>
        </div>
        <h2 className="font-display text-2xl italic uppercase mb-2">Something went wrong</h2>
        <p className="text-foreground/60 text-sm mb-4 max-w-md">
          {error.message || "An unexpected error occurred."}
        </p>
        <Button onClick={reset} className="bg-volt text-background font-display text-base px-5 py-3 skew-cta">
          Try again
        </Button>
      </div>
    );

    const Fallback = fallback ?? DefaultFallback;
    return <Fallback error={state.error!} reset={() => setState({ hasError: false, error: null })} />;
  }

  return children;
}

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  fallback?: (props: { error: Error; reset: () => void }) => React.ReactNode,
) {
  return function ErrorBoundaryComponent(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <Component {...props} />
      </ErrorBoundary>
    );
  } as React.ComponentType<P>;
}
