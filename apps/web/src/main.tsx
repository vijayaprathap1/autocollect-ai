import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "@fontsource-variable/inter";
import "./index.css";
import { Shell, AdminShell, PublicRoute, NotFound } from "./App";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Spinner } from "./components/ui";
import { ApiClientError } from "./lib/api";

// Route-level code splitting: the signed-out pages stay tiny.
const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const Terms = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Privacy })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const SignUp = lazy(() => import("./pages/SignUp").then((m) => ({ default: m.SignUp })));
const AdminLogin = lazy(() => import("./pages/AdminLogin").then((m) => ({ default: m.AdminLogin })));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail").then((m) => ({ default: m.VerifyEmail })));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite").then((m) => ({ default: m.AcceptInvite })));
const AdminConsole = lazy(() => import("./pages/AdminConsole").then((m) => ({ default: m.AdminConsole })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Invoices = lazy(() => import("./pages/Invoices").then((m) => ({ default: m.Invoices })));
const InvoiceDetail = lazy(() => import("./pages/InvoiceDetail").then((m) => ({ default: m.InvoiceDetail })));
const Customers = lazy(() => import("./pages/Customers").then((m) => ({ default: m.Customers })));
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const Templates = lazy(() => import("./pages/Templates").then((m) => ({ default: m.Templates })));
const Activity = lazy(() => import("./pages/Activity").then((m) => ({ default: m.Activity })));
const Replies = lazy(() => import("./pages/Replies").then((m) => ({ default: m.Replies })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // A data request failing with 401 means the session expired mid-use:
      // re-check /me so the shell redirects to sign-in. (Never react to /me's
      // own 401 — that is the normal signed-out state and would loop.)
      if (error instanceof ApiClientError && error.status === 401 && query.queryKey[0] !== "me") {
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Never retry client errors (4xx); retry transient failures once.
      retry: (count, error) => !(error instanceof ApiClientError && error.status >= 400 && error.status < 500) && count < 1,
    },
  },
});

function Page({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Spinner label="Loading…" />
          </div>
        }
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Public marketing page (signed-in visitors get a link back to the app) */}
            <Route path="/" element={<Page><Landing /></Page>} />
            <Route path="/terms" element={<Page><Terms /></Page>} />
            <Route path="/privacy" element={<Page><Privacy /></Page>} />
            {/* Signed-out only */}
            <Route element={<PublicRoute />}>
              <Route path="/login" element={<Page><Login /></Page>} />
              <Route path="/signup" element={<Page><SignUp /></Page>} />
              <Route path="/admin/login" element={<Page><AdminLogin /></Page>} />
              <Route path="/forgot-password" element={<Page><ForgotPassword /></Page>} />
            </Route>
            {/* Token links: work whether or not someone is signed in */}
            <Route path="/reset-password" element={<Page><ResetPassword /></Page>} />
            <Route path="/verify-email" element={<Page><VerifyEmail /></Page>} />
            <Route path="/accept-invite" element={<Page><AcceptInvite /></Page>} />
            {/* Workspace */}
            <Route element={<Shell />}>
              <Route path="/dashboard" element={<Page><Dashboard /></Page>} />
              <Route path="/invoices" element={<Page><Invoices /></Page>} />
              <Route path="/invoices/:id" element={<Page><InvoiceDetail /></Page>} />
              <Route path="/customers" element={<Page><Customers /></Page>} />
              <Route path="/workflows" element={<Page><Workflows /></Page>} />
              <Route path="/templates" element={<Page><Templates /></Page>} />
              <Route path="/activity" element={<Page><Activity /></Page>} />
              <Route path="/replies" element={<Page><Replies /></Page>} />
              <Route path="/settings" element={<Page><Settings /></Page>} />
            </Route>
            <Route element={<AdminShell />}>
              <Route path="/admin" element={<Page><AdminConsole /></Page>} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
