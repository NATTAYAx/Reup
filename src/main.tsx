import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// A number field that has focus will change its value when the wheel scrolls
// over it, which quietly corrupts an amount while the user is only scrolling
// the page. Blurring on wheel is the standard fix and belongs here, once, rather
// than on every input in the app.
document.addEventListener(
  "wheel",
  () => {
    const el = document.activeElement as HTMLInputElement | null;
    if (el && el.tagName === "INPUT" && el.type === "number") el.blur();
  },
  { passive: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);