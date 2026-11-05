import React from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches render crashes so the user sees a recovery screen instead of a blank page.
 * Projects are saved on-device continuously, so reloading loses at most the last second of work.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Aether crashed:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-app text-ink p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-mute mt-2 leading-relaxed">
            Your projects are saved on this device. Reload to continue where you left off.
          </p>
          <pre className="mt-4 text-left text-[11px] text-mute bg-panel border border-line rounded-lg p-3 overflow-auto max-h-32">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 h-10 px-5 rounded-lg brand-gradient text-white text-sm font-semibold"
          >
            Reload Aether
          </button>
        </div>
      </div>
    );
  }
}
