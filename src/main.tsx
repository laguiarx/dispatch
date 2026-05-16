import React from "react";
import ReactDOM from "react-dom/client";
// Bundled UI / code fonts. Variable builds keep weight axis flexible while
// avoiding a network round-trip to Google Fonts on every launch.
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { App } from "./app/app";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
