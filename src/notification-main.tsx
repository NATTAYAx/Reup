import React from "react";
import ReactDOM from "react-dom/client";
import NotificationOverlay from "./components/NotificationOverlay";
// Import your global CSS (Tailwind) the same way the main app does
import "./index.css"; // adjust path if needed

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NotificationOverlay />
  </React.StrictMode>
);