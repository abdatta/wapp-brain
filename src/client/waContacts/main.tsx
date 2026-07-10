import React from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "../AppErrorBoundary";
import "../styles.css";
import { WaContactsPage } from "./WaContactsPage";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <WaContactsPage />
    </AppErrorBoundary>
  </React.StrictMode>
);
