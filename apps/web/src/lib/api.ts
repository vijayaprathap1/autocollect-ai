import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { useToast } from "@/components/ui";

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";
/** Cross-origin API (split-domain deploy) needs `include` so the session cookie is sent. */
const CREDENTIALS: RequestCredentials = /^https?:\/\//.test(API_BASE) ? "include" : "same-origin";

export type ApiErrorBody = { error: { code: string; message: string; requestId?: string } };

export class ApiClientError extends Error {
  status: number;
  code: string;
  requestId?: string;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Absolute URL for top-level navigations to the API (OAuth starts, etc.). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasJsonBody = typeof init.body === "string";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: CREDENTIALS,
      headers: {
        // Required by the API's CSRF protection for authenticated writes.
        "x-requested-with": "autocollect-web",
        ...(hasJsonBody ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiClientError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error */
    }
    const message =
      body?.error?.message ??
      (res.status >= 500 ? "Something went wrong on our side. Please try again." : `Request failed (${res.status})`);
    throw new ApiClientError(res.status, body?.error?.code ?? "HTTP_ERROR", message, body?.error?.requestId);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ─── Me / auth ──────────────────────────────────────────────────────────────

export type TenantBranding = {
  appName?: string;
  logoUrl?: string;
  primaryColor?: string;
  hideBranding?: boolean;
  businessAddress?: string;
};

export type Role = "owner" | "admin" | "member";

export type MeResponse = {
  user: {
    id: string;
    role: Role | null;
    email: string;
    displayName: string | null;
    isSuperAdmin: boolean;
    sessionType?: "tenant" | "admin";
    organizationCount: number;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    tone: "friendly" | "professional" | "firm";
    emailDomain: string | null;
    currency: string;
    timezone: string;
    sendHour: number;
    skipWeekends: boolean;
    replyNotifications: boolean;
    plan: string;
    planName: string;
    invoiceLimit: number | null;
    seatLimit: number | null;
    seatsUsed: number;
    branding: TenantBranding;
    workflowEnabled: boolean;
    hasUnapprovedTemplates: boolean;
    invoiceCount: number;
    creditBalance: number;
    creditsPerMonth: number;
    stripeConnected: boolean;
    subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; canManageBilling: boolean };
  } | null;
  templates: { approvedTemplates: number; totalTemplates: number };
};

export const fetchMe = () => api.get<MeResponse>("/me");

export type Providers = { password: boolean; google: boolean; signup: boolean };
export const getProviders = () => api.get<Providers>("/auth/providers");

export const login = (email: string, password: string, rememberMe: boolean) =>
  api.post<{ ok: boolean }>("/auth/login", { email, password, rememberMe });
export const adminLogin = (email: string, password: string) => api.post<{ ok: boolean }>("/auth/admin/login", { email, password });
export const signup = (body: { name: string; email: string; password: string; organizationName?: string; timezone?: string }) =>
  api.post<{ ok: boolean; message: string }>("/auth/signup", body);
export const resendVerification = (email: string) => api.post<{ ok: boolean; message: string }>("/auth/resend-verification", { email });
export const verifyEmail = (token: string) => api.post<{ ok: boolean; signedIn: boolean }>("/auth/verify-email", { token });
export const forgotPassword = (email: string) => api.post<{ ok: boolean; message: string }>("/auth/forgot-password", { email });
export const resetPassword = (token: string, password: string) => api.post<{ ok: boolean; message: string }>("/auth/reset-password", { token, password });
export const logout = () => api.post<{ ok: boolean }>("/auth/logout");
export const changePassword = (currentPassword: string, newPassword: string) =>
  api.post<{ ok: boolean; otherSessionsSignedOut: number }>("/auth/change-password", { currentPassword, newPassword });
export const updateProfile = (displayName: string) => api.put<{ ok: boolean; displayName: string }>("/auth/profile", { displayName });

export type SessionDto = { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean };
export const getSessions = () => api.get<{ sessions: SessionDto[] }>("/auth/sessions");
export const revokeSession = (id: string) => api.del<{ ok: boolean }>(`/auth/sessions/${id}`);
export const revokeOtherSessions = () => api.post<{ ok: boolean; revoked: number }>("/auth/sessions/revoke-others");

export type OrganizationDto = { id: string; name: string; slug: string; role: Role; current: boolean };
export const getOrganizations = () => api.get<{ organizations: OrganizationDto[] }>("/auth/organizations");
export const switchOrganization = (tenantId: string) => api.post<{ ok: boolean }>("/auth/switch-organization", { tenantId });
export async function createOrganization(name: string): Promise<{ ok: boolean; tenantId: string; tenantSlug: string; role: string }> {
  return api.post("/auth/create-organization", { name });
}

export async function seedDemo(): Promise<{ ok: boolean; customers: number; invoices: number }> {
  return api.post<{ ok: boolean; customers: number; invoices: number }>("/demo/seed");
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type OrganizationSettings = Partial<{
  name: string;
  tone: "friendly" | "professional" | "firm";
  currency: string;
  timezone: string;
  sendHour: number;
  skipWeekends: boolean;
  replyNotifications: boolean;
}>;
export const updateOrganization = (body: OrganizationSettings) => api.put<{ ok: boolean }>("/settings/organization", body);

// ─── Privacy (GDPR) ─────────────────────────────────────────────────────────

/** Download the workspace's data as a JSON file. */
export async function downloadWorkspaceExport(slug: string): Promise<void> {
  const data = await api.get<unknown>("/settings/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `autocollect-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
export const deleteWorkspace = (confirmName: string, password: string) =>
  api.post<{ ok: boolean }>("/settings/delete-workspace", { confirmName, password: password || undefined });
export const deleteAccount = (confirmEmail: string, password: string) =>
  api.post<{ ok: boolean }>("/auth/delete-account", { confirmEmail, password: password || undefined });

export async function updateBranding(branding: Partial<TenantBranding>): Promise<{ branding: TenantBranding; plan: string }> {
  return api.put<{ branding: TenantBranding; plan: string }>("/settings/branding", branding);
}

// ─── Integrations ───────────────────────────────────────────────────────────

export type IntegrationDto = {
  id: string;
  source: string;
  status: string;
  createdAt: string;
  accountId: string | null;
  livemode: boolean | null;
  importComplete: boolean | null;
  lastSyncAt: string | null;
};

export type IntegrationsResponse = {
  integrations: IntegrationDto[];
  sms: { enabled: boolean; mock: boolean; fromNumber: string | null };
  stripe: { mode: "live" | "test" | "mock" };
};

export const getIntegrations = () => api.get<IntegrationsResponse>("/integrations");
export const stripeConnect = () => api.post<{ url: string }>("/integrations/stripe/connect");
export const stripeDisconnect = () => api.post<{ ok: boolean }>("/integrations/stripe/disconnect");
export const qboConnect = () => api.post<{ url: string }>("/integrations/qbo/connect");
export const qboSync = () => api.post<{ synced: number; mock: boolean; lastSyncAt: string }>("/integrations/qbo/sync");

// ─── Customers / invoices ───────────────────────────────────────────────────

export type CustomerDto = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  smsOptOut: boolean;
  createdAt: string;
  openCount: number;
  openTotal: number;
  paidCount: number;
};

function qs(params?: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function getCustomers(params?: { q?: string; limit?: number; offset?: number }) {
  return api.get<{ customers: CustomerDto[]; limit: number; offset: number; hasMore: boolean }>(`/customers${qs(params)}`);
}

export type InvoiceDto = {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  externalId: string | null;
  source: string;
  amountDue: number;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  status: string;
  paymentLink: string | null;
  lineItems: unknown;
  nextStepIndex: number;
  nextStepDueAt: string | null;
  snoozedUntil?: string | null;
  lastPaymentFailure?: { at: string; reason: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceListResponse = { invoices: InvoiceDto[]; limit: number; offset: number; hasMore: boolean };

export async function getInvoices(params?: { status?: string; source?: string; q?: string; limit?: number; offset?: number }) {
  return api.get<InvoiceListResponse>(`/invoices${qs(params)}`);
}

export type TimelineEntry = {
  id: string;
  kind: "send" | "reply";
  stepIndex: number | null;
  channel: string;
  status: string;
  sentAt: string | null;
  error?: string | null;
  content: string | null;
  classification: string | null;
  promiseDate: string | null;
};

export type InvoiceDetailResponse = { invoice: InvoiceDto; timeline: TimelineEntry[] };

export const getInvoice = (id: string) => api.get<InvoiceDetailResponse>(`/invoices/${id}`);

export type InvoiceAction = "pause" | "resume" | "mark_paid" | "mark_uncollectible" | "reopen" | "send_now";
export async function invoiceAction(id: string, action: InvoiceAction | string): Promise<{ ok: boolean; status: string; sent?: boolean }> {
  return api.post(`/invoices/${id}/actions`, { action });
}

export async function createPayLink(id: string): Promise<{ paymentLink: string }> {
  return api.post<{ paymentLink: string }>(`/invoices/${id}/pay-link`);
}

// ─── Workflows / templates ──────────────────────────────────────────────────

export type WorkflowStepDto = { order: number; delayDays: number; channel: "email" | "sms" | string; templateId: string | null };

export type WorkflowDto = {
  id: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  steps: WorkflowStepDto[];
  createdAt: string;
};

export const getWorkflows = () => api.get<{ workflows: WorkflowDto[]; smsAvailable: boolean }>("/workflows");

export async function updateWorkflow(id: string, body: { enabled?: boolean; name?: string; steps?: WorkflowStepDto[] }): Promise<{ workflow: WorkflowDto }> {
  return api.put<{ workflow: WorkflowDto }>(`/workflows/${id}`, body);
}

export type TemplateDto = {
  id: string;
  stepKey: string;
  subject: string;
  body: string;
  approved: boolean;
  createdAt: string;
  unknownPlaceholders?: string[];
};

export const getTemplates = () => api.get<{ templates: TemplateDto[]; variables?: string[] }>("/templates");

export async function updateTemplate(id: string, body: { subject?: string; body?: string; approved?: boolean }): Promise<{ template: TemplateDto }> {
  return api.put<{ template: TemplateDto }>(`/templates/${id}`, body);
}

export async function draftTemplates(): Promise<{ drafts: { stepKey: string; subject: string; body: string }[] }> {
  return api.post<{ drafts: { stepKey: string; subject: string; body: string }[] }>("/templates/draft");
}

// ─── Dashboard / activity / replies ─────────────────────────────────────────

export type DashboardRangeKey = "7d" | "30d" | "90d";
export type DashboardRange = { from: string; to: string; asOf: string; lastUpdatedAt: string | null };
export type DashboardCurrency = string;
export type DashboardCredits = { balance: number; monthlyAllowance: number; periodStart: string | null; periodEnd: string | null; subscriptionStatus: string | null };

export type DashboardSummaryDto = {
  outstandingTotal: number;
  overdueTotal: number;
  recovered30d: number;
  avgDsoDays: number | null;
  aging: { bucket: string; count: number; amount: number }[];
  openCount: number;
  paidCount30d: number;
  range: DashboardRange;
  currency: DashboardCurrency;
  credits: DashboardCredits;
};

export const getDashboard = (range: DashboardRangeKey = "30d") => api.get<DashboardSummaryDto>(`/dashboard?range=${range}`);

export type ActivityResponse = {
  audit: { id: string; actor: string; action: string; detail: unknown; createdAt: string }[];
  messages: { id: string; channel: string; status: string; sentAt: string | null; stepIndex: number; invoiceNumber: string | null; customerName: string | null }[];
  replies: { id: string; classification: string; content: string; createdAt: string; invoiceNumber: string | null; customerName: string | null }[];
};

export const getActivity = () => api.get<ActivityResponse>("/activity");

export type ReplyInboxItem = {
  id: string;
  invoiceId: string | null;
  content: string;
  classification: string;
  suggestedBody: string | null;
  resolved: boolean;
  createdAt: string;
  customerName: string | null;
  customerEmail: string | null;
  invoiceNumber: string | null;
};

export const getReplies = () => api.get<{ replies: ReplyInboxItem[] }>("/replies");

export async function replyAction(id: string, action: "send" | "regenerate" | "resolve", body?: string) {
  return api.put<{ ok: boolean; action: string; suggestedBody?: string | null }>(`/replies/${id}`, body !== undefined ? { action, body } : { action });
}

// ─── Billing ────────────────────────────────────────────────────────────────

export type PlanDto = {
  key: string;
  name: string;
  monthlyPriceCents: number;
  invoiceLimit: number | null;
  seatLimit: number | null;
  creditsPerMonth: number;
  whiteLabel: boolean;
  available: boolean;
};

export type BillingDto = {
  plan: string;
  planName?: string;
  invoiceLimit: number | null;
  invoicesUsed: number;
  seatLimit?: number | null;
  seatsUsed?: number;
  credits?: { balance: number; perMonth: number; sentLast30Days: number };
  subscription?: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; managedByStripe: boolean };
  canManageBilling?: boolean;
  mode?: "stripe" | "mock" | "disabled";
  plans?: PlanDto[];
};

export const getBilling = () => api.get<BillingDto>("/billing");
export const billingCheckout = (plan: string) => api.post<{ url: string; plan: string; mode?: string }>("/billing/checkout", { plan });
export const billingPortal = () => api.post<{ url: string }>("/billing/portal");

// ─── Team ───────────────────────────────────────────────────────────────────

export type MemberDto = {
  id: string;
  email: string | null;
  displayName?: string | null;
  role: Role | string;
  createdAt: string;
  lastLoginAt?: string | null;
  isYou?: boolean;
};

export const getMembers = () => api.get<{ members: MemberDto[] }>("/users");
export const changeMemberRole = (id: string, role: Role) => api.put<{ ok: boolean }>(`/users/${id}/role`, { role });
export const removeMember = (id: string) => api.del<{ ok: boolean }>(`/users/${id}`);
export const leaveWorkspace = () => api.post<{ ok: boolean }>("/users/leave");

export type InvitationDto = { id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string };

export const getInvitations = () => api.get<{ invitations: InvitationDto[] }>("/invitations");
export const sendInvitation = (email: string, role = "member") => api.post<{ invitation: InvitationDto }>("/invitations", { email, role });
export const resendInvitation = (id: string) => api.post<{ ok: boolean }>(`/invitations/${id}/resend`);
export const revokeInvitation = (id: string) => api.del<{ ok: boolean }>(`/invitations/${id}`);

export type InvitationPreview = { email: string; role: string; organizationName: string; accountExists: boolean };
export const previewInvitation = (id: string, token: string) =>
  api.get<InvitationPreview>(`/invitations/${encodeURIComponent(id)}/preview?token=${encodeURIComponent(token)}`);
export async function acceptInvitation(id: string, token: string, account?: { displayName: string; password: string }) {
  return api.post<{ ok: boolean; message: string; tenantId: string }>(`/invitations/${encodeURIComponent(id)}/accept`, { token, ...account });
}

// ─── CSV import ─────────────────────────────────────────────────────────────

export type CsvImportResult = {
  imported: number;
  failed: number;
  total: number;
  errors: { row: number; error: string }[];
  mapping?: Record<string, string>;
};

export async function importCsv(file: File, opts: { dateFormat?: "mdy" | "dmy" } = {}): Promise<CsvImportResult> {
  const fd = new FormData();
  if (opts.dateFormat) fd.append("dateFormat", opts.dateFormat);
  fd.append("file", file);
  return request<CsvImportResult>("/integrations/csv/import", { method: "POST", body: fd });
}

// ─── Mutation helper ────────────────────────────────────────────────────────

export function useApiMutation<TData, TVariables, TError extends ApiClientError, TContext = unknown>(
  mutationFn: (vars: TVariables) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, TError, TVariables, TContext>, "mutationFn" | "onError">,
) {
  const { showToast } = useToast();
  return useMutation<TData, TError, TVariables, TContext>({
    mutationFn,
    ...options,
    onError: (error) => showToast(error.message, "error"),
  });
}

/** Human message for any thrown value. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
