import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "katex/dist/katex.min.css";
import "./styles.css";

class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the user-facing fallback free of stack traces or remote content, but
    // retain the diagnostic where a development console can inspect it.
    console.error("Reading Hub renderer failed to start", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? <RendererStartupFallback /> : this.props.children;
  }
}

function RendererStartupFallback({ bridgeMissing = false }: { bridgeMissing?: boolean }) {
  return <main className="renderer-startup-fallback" role="alert">
    <div>
      <p className="eyebrow">READING HUB</p>
      <h1>{bridgeMissing ? "本机桥接未能加载" : "阅读器未能加载"}</h1>
      <p>{bridgeMissing
        ? "应用的本机通信组件没有就绪。请重新加载；若仍存在，请停止并重新运行 npm run dev。"
        : "发生了启动错误。请重新加载；若仍存在，请在开发者工具中查看错误详情。"}</p>
      <button type="button" className="primary" onClick={() => window.location.reload()}>重新加载</button>
    </div>
  </main>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Reading Hub 缺少渲染根节点。");
const readerBridge = (window as Window & { reader?: unknown }).reader;

createRoot(rootElement).render(
  <StrictMode>
    {readerBridge ? <RendererErrorBoundary><App /></RendererErrorBoundary> : <RendererStartupFallback bridgeMissing />}
  </StrictMode>
);
