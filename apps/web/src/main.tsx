import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Shell, PublicOutlet } from "./App";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Invoices } from "./pages/Invoices";
import { InvoiceDetail } from "./pages/InvoiceDetail";
import { Customers } from "./pages/Customers";
import { Workflows } from "./pages/Workflows";
import { Templates } from "./pages/Templates";
import { Activity } from "./pages/Activity";
import { Replies } from "./pages/Replies";
import { Settings } from "./pages/Settings";
import { ToastProvider } from "./components/Toast";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<PublicOutlet />}>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
            </Route>
            <Route element={<Shell />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/invoices" element={<Invoices />} />
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/replies" element={<Replies />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);