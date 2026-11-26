"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";

type Props = {
  children: React.ReactNode;
  fallbackTitle?: string;
};

type State = {
  hasError: boolean;
  message: string;
};

export default class SupportErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || "Unexpected interface error",
    };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="panel p-8 text-center space-y-3 max-w-lg mx-auto my-8">
          <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle size={22} />
          </div>
          <h2 className="text-sm font-bold text-foreground">
            {this.props.fallbackTitle || "Something went wrong in this view"}
          </h2>
          <p className="text-xs text-muted-foreground">{this.state.message}</p>
          <div className="pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => this.setState({ hasError: false, message: "" })}
            >
              <RefreshCw size={13} /> Retry view
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
