import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LabApp } from "./LabApp";
import "./lab.css";

const container = document.getElementById("lab-root");
if (!container) throw new Error("#lab-root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <LabApp />
  </StrictMode>
);
