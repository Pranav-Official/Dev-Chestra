import { Outlet } from "react-router-dom";
import { useGlobalStream } from "../api/hooks.js";
import { Sidebar } from "./Sidebar.js";

export function AppShell() {
  useGlobalStream();
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-col">
        <Outlet />
      </main>
    </div>
  );
}
