import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import "./index.css";
import { Shell, AdminShell, PublicRoute } from "./App";
import { Login } from "./pages/Login";
import { SignUp } from "./pages/SignUp";
import { AdminLogin } from "./pages/AdminLogin";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { VerifyEmail } from "./pages/VerifyEmail";
import { AcceptInvite } from "./pages/AcceptInvite";
import { AdminConsole } from "./pages/AdminConsole";
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
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route element={<PublicRoute />}>
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<SignUp />} />
              <Route path="/admin/login" element={<AdminLogin />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route path="/accept-invite" element={<AcceptInvite />} />
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
            <Route element={<AdminShell />}>
              <Route path="/admin" element={<AdminConsole />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
