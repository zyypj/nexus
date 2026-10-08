import { cssVariables } from "@nexus/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./servers.css";

for (const [k, v] of Object.entries(cssVariables())) document.documentElement.style.setProperty(k, v);

// Files dropped outside a drop zone must not make the WebView open them.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (!e.defaultPrevented && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

