import React from "react";
import ReactDOM from "react-dom/client";
import DesktopWidget from "./components/DesktopWidget";
// The same stylesheet as the app, for the typeface and the theme variables.
import "./index.css";
// And one lighter weight for the clock's digits, which only the board uses.
import "@fontsource/ibm-plex-sans-thai/latin-300.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopWidget />
  </React.StrictMode>
);
