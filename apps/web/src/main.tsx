import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { createQueryClient } from "./api/queryClient.js";
import { appRoutes } from "./app.js";
import { initTheme } from "./theme.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/run.css";
import "./styles/editor-page.css";

initTheme();
const queryClient = createQueryClient();
const router = createBrowserRouter(appRoutes);
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
