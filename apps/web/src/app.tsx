import { Navigate, type RouteObject } from "react-router-dom";
import { EditorRoute } from "./editor/page/EditorPage.js";
import { HomePage } from "./pages/HomePage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { ProjectRunsPage } from "./pages/ProjectRunsPage.js";
import { RunRoute } from "./pages/RunPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { WorkflowsPage } from "./pages/WorkflowsPage.js";
import { AppShell } from "./shell/AppShell.js";

/**
 * Data-router routes. `useBlocker` (the unsaved-editor guard) requires a data
 * router, so `main.tsx` installs these through `createBrowserRouter`.
 */
export const appRoutes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "p/:pid", element: <Navigate to="workflows" replace /> },
      { path: "p/:pid/workflows", element: <WorkflowsPage /> },
      { path: "p/:pid/runs", element: <ProjectRunsPage /> },
      { path: "p/:pid/w/:wid", element: <EditorRoute /> },
      { path: "p/:pid/r/:rid", element: <RunRoute /> },
      { path: "settings", element: <Navigate to="providers" replace /> },
      { path: "settings/providers", element: <SettingsPage /> },
      { path: "settings/usage", element: <SettingsPage /> },
      { path: "settings/execution", element: <SettingsPage /> },
      { path: "p/:pid/settings", element: <Navigate to="providers" replace /> },
      { path: "p/:pid/settings/providers", element: <SettingsPage /> },
      { path: "p/:pid/settings/usage", element: <SettingsPage /> },
      { path: "p/:pid/settings/execution", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
