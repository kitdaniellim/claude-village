// Contains a crash to the panel it happened in. Without it, one throwing render (a bad hot edit, a
// malformed log entry) unmounts the whole app — and with it every village terminal.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-crash" role="alert">
        <span>
          {this.props.name} crashed — terminals are unaffected. <code>{this.state.error.message}</code>
        </span>
        <button type="button" className="ui-btn" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
