import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./compact-iframe.css";
import "./compact-iframe-polish.css";
import "./client-csv-import.css";
import "./csv-import-enhancer.css";
import "./csv-import-enhancer";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
