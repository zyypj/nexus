import { cssVariables } from "@nexus/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

for (const [k, v] of Object.entries(cssVariables())) document.documentElement.style.setProperty(k, v);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

