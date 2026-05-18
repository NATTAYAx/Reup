/**
 * DebugOverlay.tsx
 * 
 * Add to App.tsx temporarily:
 *   import DebugOverlay from "./components/DebugOverlay";
 *   <DebugOverlay countdowns={countdowns} />
 * 
 * Shows real-time diagnostics. Remove before shipping.
 */
import { useState, useEffect, useRef } from "react";
import { CountdownResult } from "../types";

interface Props {
  countdowns: CountdownResult[];
}

export default function DebugOverlay({ countdowns }: Props) {
  const [visible, setVisible] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const renderCount = useRef(0);
  const prevOrderRef = useRef<string>("");
  const prevCountRef = useRef(0);

  useEffect(() => {
    renderCount.current++;
    const order = countdowns.map(c => c.task.id).join(",");
    const msgs: string[] = [];

    // Detect order change
    if (prevOrderRef.current && prevOrderRef.current !== order) {
      msgs.push(`⚠️ ORDER CHANGED: [${prevOrderRef.current}] → [${order}]`);
    }
    prevOrderRef.current = order;

    // Detect count change
    if (prevCountRef.current !== countdowns.length) {
      msgs.push(`📊 COUNT: ${prevCountRef.current} → ${countdowns.length}`);
    }
    prevCountRef.current = countdowns.length;

    if (msgs.length > 0) {
      setLog(prev => [...msgs, ...prev].slice(0, 20));
    }
  });

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        style={{
          position: "fixed", bottom: 8, left: 8, zIndex: 9999,
          background: "rgba(0,0,0,0.7)", color: "#888", fontSize: 9,
          padding: "2px 6px", borderRadius: 4, border: "1px solid #333",
          cursor: "pointer",
        }}
      >
        🐛 debug
      </button>
    );
  }

  return (
    <div style={{
      position: "fixed", bottom: 8, left: 8, zIndex: 9999,
      background: "rgba(0,0,0,0.92)", border: "1px solid #444",
      borderRadius: 8, padding: 8, width: 320, maxHeight: 280,
      overflow: "hidden", fontSize: 10, fontFamily: "monospace",
      color: "#aaa",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#888", fontWeight: "bold" }}>🐛 GameSched Debug</span>
        <button onClick={() => setVisible(false)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ color: "#6f9", marginBottom: 4 }}>
        renders: {renderCount.current} | tasks: {countdowns.length}
      </div>
      <div style={{ marginBottom: 4 }}>
        <span style={{ color: "#888" }}>IDs: </span>
        <span style={{ color: "#fc9" }}>{countdowns.map(c => c.task.id).join(", ")}</span>
      </div>
      <div style={{ marginBottom: 4 }}>
        {countdowns.map(c => (
          <div key={c.task.id} style={{ color: c.urgency === "expired" ? "#f66" : c.urgency === "critical" ? "#f96" : "#aaa" }}>
            [{c.task.id}] {c.task.name.slice(0,16)} | {c.task.reset_type} | {c.urgency} | end={String(c.task.event_end ?? "null").slice(0,20)}
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid #333", paddingTop: 4, maxHeight: 80, overflowY: "auto" }}>
        {log.length === 0
          ? <span style={{ color: "#555" }}>no changes detected</span>
          : log.map((l, i) => <div key={i} style={{ color: i === 0 ? "#f96" : "#666" }}>{l}</div>)
        }
      </div>
    </div>
  );
}