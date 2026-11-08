import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onRetry) {
      this.props.onRetry();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="p-6 my-4 text-center rounded-2xl bg-amber-50/70 border border-amber-200 text-sg-ink flex flex-col items-center justify-center gap-3">
          <AlertTriangle className="w-8 h-8 text-amber-600 shrink-0" />
          <div className="space-y-1">
            <p className="font-bold text-[15px] text-sg-ink">這個區塊載入失敗，請重新整理</p>
            {this.state.error?.message && (
              <p className="text-[12px] text-sg-muted max-w-sm truncate">{this.state.error.message}</p>
            )}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-sg-line hover:border-sg-brown text-sg-ink text-[13px] font-bold shadow-xs transition active:scale-95"
          >
            <RotateCw className="w-4 h-4 text-sg-brown" />
            <span>重試</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
