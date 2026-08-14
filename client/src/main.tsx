import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyStoredCampaignWorkbenchPreferences } from "./components/rpg/play/campaignWorkbenchPreferences";

applyStoredCampaignWorkbenchPreferences();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
