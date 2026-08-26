import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { useToast } from "@/components/ui";

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

export type ApiErrorBody = { error: { code: string; message: string } };

export class ApiClientError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  return h;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { ...headers(hasBody), ...init.headers },
  });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* ignore */
    }
    throw new ApiClientError(
      res.status,
      body?.error.code ?? "HTTP_ERROR",
      body?.error.message ?? `Request failed (${res.status})`,
    );
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

export type TenantBranding = {
  appName?: string;
  logoUrl?: string;
  primaryColor?: string;
  hideBranding?: boolean;
};

export type MeResponse = {
  user: { id: string; role: string; email: string; isSuperAdmin: boolean; sessionType?: "tenant" | "admin" };
  tenant: {
    id: string;
    name: string;
    slug: string;
    tone: string;
    emailDomain: string | null;
    plan: string;
    invoiceLimit: number | null;
    seatLimit: number | null;
    seatsUsed: number;
    branding: TenantBranding;
    workflowEnabled: boolean;
    hasUnapprovedTemplates: boolean;
    invoiceCount: number;
    creditBalance: number;
    creditsPerMonth: number;
  } | null;
  templates: { approvedTemplates: number; totalTemplates: number };
};

export async function fetchMe(): Promise<MeResponse> {
  return api.get<MeResponse>("/me");
}

export async function seedDemo(): Promise<{ ok: boolean; customers: number; invoices: number }> {
  return api.post<{ ok: boolean; customers: number; invoices: number }>("/demo/seed");
}

export type IntegrationDto = {
  id: string;
  source: string;
  status: string;
  createdAt: string;
};

export type IntegrationsResponse = {
  integrations: IntegrationDto[];
  sms: { enabled: boolean; mock: boolean; fromNumber: string | null };
};

export async function getIntegrations(): Promise<IntegrationsResponse> {
  return api.get<IntegrationsResponse>("/integrations");
}

export async function stripeConnect(): Promise<{ url: string }> {
  return api.post<{ url: string }>("/integrations/stripe/connect");
}

export async function qboConnect(): Promise<{ url: string }> {
  return api.post<{ url: string }>("/integrations/qbo/connect");
}

export async function qboSync(): Promise<{ synced: number; mock: boolean; lastSyncAt: string }> {
  return api.post<{ synced: number; mock: boolean; lastSyncAt: string }>("/integrations/qbo/sync");
}

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

export async function getCustomers(params?: { q?: string; limit?: number; offset?: number }): Promise<{
  customers: CustomerDto[];
  limit: number;
  offset: number;
  hasMore: boolean;
}> {
  const sp = new URLSearchParams();
  if (params?.q) sp.set("q", params.q);
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.offset !== undefined) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return api.get<{ customers: CustomerDto[]; limit: number; offset: number; hasMore: boolean }>(
    `/customers${qs ? `?${qs}` : ""}`,
  );
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
  createdAt: string;
  updatedAt: string;
};

export type InvoiceListResponse = { invoices: InvoiceDto[]; limit: number; offset: number; hasMore: boolean };

export async function getInvoices(params?: {
  status?: string;
  source?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<InvoiceListResponse> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.source) sp.set("source", params.source);
  if (params?.q) sp.set("q", params.q);
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.offset !== undefined) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return api.get<InvoiceListResponse>(`/invoices${qs ? `?${qs}` : ""}`);
}

export type TimelineEntry = {
  id: string;
  kind: "send" | "reply";
  stepIndex: number | null;
  channel: string;
  status: string;
  sentAt: string | null;
  content: string | null;
  classification: string | null;
  promiseDate: string | null;
};

export type InvoiceDetailResponse = {
  invoice: InvoiceDto;
  timeline: TimelineEntry[];
};

export async function getInvoice(id: string): Promise<InvoiceDetailResponse> {
  return api.get<InvoiceDetailResponse>(`/invoices/${id}`);
}

export async function invoiceAction(id: string, action: string): Promise<{ ok: boolean; status: string }> {
  return api.post<{ ok: boolean; status: string }>(`/invoices/${id}/actions`, { action });
}

export type WorkflowDto = {
  id: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  steps: {
    order: number;
    delayDays: number;
    channel: string;
    templateId: string | null;
  }[];
  createdAt: string;
};

export async function getWorkflows(): Promise<{ workflows: WorkflowDto[] }> {
  return api.get<{ workflows: WorkflowDto[] }>("/workflows");
}

export async function updateWorkflow(
  id: string,
  body: { enabled?: boolean; name?: string; steps?: WorkflowDto["steps"] },
): Promise<{ workflow: WorkflowDto }> {
  return api.put<{ workflow: WorkflowDto }>(`/workflows/${id}`, body);
}

export type TemplateDto = {
  id: string;
  stepKey: string;
  subject: string;
  body: string;
  approved: boolean;
  createdAt: string;
};

export async function getTemplates(): Promise<{ templates: TemplateDto[] }> {
  return api.get<{ templates: TemplateDto[] }>("/templates");
}

export async function updateTemplate(
  id: string,
  body: { subject?: string; body?: string; approved?: boolean },
): Promise<{ template: TemplateDto }> {
  return api.put<{ template: TemplateDto }>(`/templates/${id}`, body);
}

export async function draftTemplates(): Promise<{
  drafts: { stepKey: string; subject: string; body: string }[];
}> {
  return api.post<{ drafts: { stepKey: string; subject: string; body: string }[] }>("/templates/draft");
}

export type DashboardRangeKey = "7d" | "30d" | "90d";

export type DashboardRange = {
  from: string;
  to: string;
  asOf: string;
  lastUpdatedAt: string | null;
};

export type DashboardCurrency = string;

export type DashboardCredits = {
  balance: number;
  monthlyAllowance: number;
  periodStart: string | null;
  periodEnd: string | null;
  subscriptionStatus: string | null;
};

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

export async function getDashboard(range: DashboardRangeKey = "30d"): Promise<DashboardSummaryDto> {
  const params = new URLSearchParams({ range });
  return api.get<DashboardSummaryDto>(`/dashboard?${params.toString()}`);
}

export type ActivityResponse = {
  audit: { id: string; actor: string; action: string; detail: unknown; createdAt: string }[];
  messages: {
    id: string;
    channel: string;
    status: string;
    sentAt: string | null;
    stepIndex: number;
    invoiceNumber: string | null;
    customerName: string | null;
  }[];
  replies: {
    id: string;
    classification: string;
    content: string;
    createdAt: string;
    invoiceNumber: string | null;
    customerName: string | null;
  }[];
};

export async function getActivity(): Promise<ActivityResponse> {
  return api.get<ActivityResponse>("/activity");
}

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

export async function getReplies(): Promise<{ replies: ReplyInboxItem[] }> {
  return api.get<{ replies: ReplyInboxItem[] }>("/replies");
}

export async function replyAction(
  id: string,
  action: "send" | "regenerate" | "resolve",
  body?: string,
): Promise<{ ok: boolean; action: string; suggestedBody?: string | null }> {
  return api.put<{ ok: boolean; action: string; suggestedBody?: string | null }>(
    `/replies/${id}`,
    body !== undefined ? { action, body } : { action },
  );
}

export type BillingDto = { plan: string; invoiceLimit: number | null; invoicesUsed: number };

export async function getBilling(): Promise<BillingDto> {
  return api.get<BillingDto>("/billing");
}

export async function billingCheckout(plan: string): Promise<{ url: string; plan: string }> {
  return api.post<{ url: string; plan: string }>("/billing/checkout", { plan });
}

export type MemberDto = { id: string; email: string | null; role: string; createdAt: string };

export async function getMembers(): Promise<{ members: MemberDto[] }> {
  return api.get<{ members: MemberDto[] }>("/users");
}

export async function addMember(email: string, role = "member"): Promise<{ member: MemberDto }> {
  return api.post<{ member: MemberDto }>("/users", { email, role });
}

export type InvitationDto = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

export async function getInvitations(): Promise<{ invitations: InvitationDto[] }> {
  return api.get<{ invitations: InvitationDto[] }>("/invitations");
}

export async function sendInvitation(email: string, role = "member"): Promise<{ invitation: InvitationDto }> {
  return api.post<{ invitation: InvitationDto }>("/invitations", { email, role });
}

export async function revokeInvitation(id: string): Promise<{ ok: boolean }> {
  return api.del<{ ok: boolean }>(`/invitations/${id}`);
}

export async function acceptInvitation(id: string, token: string): Promise<{ ok: boolean; message: string }> {
  return api.post<{ ok: boolean; message: string }>(`/invitations/${id}/accept`, { token });
}

export async function createOrganization(name: string): Promise<{ ok: boolean; tenantId: string; tenantSlug: string; role: string }> {
  return api.post<{ ok: boolean; tenantId: string; tenantSlug: string; role: string }>("/auth/create-organization", { name });
}

export async function updateBranding(
  branding: Partial<TenantBranding>,
): Promise<{ branding: TenantBranding; plan: string }> {
  return api.put<{ branding: TenantBranding; plan: string }>("/settings/branding", branding);
}

export async function createPayLink(id: string): Promise<{ paymentLink: string }> {
  return api.post<{ paymentLink: string }>(`/invoices/${id}/pay-link`);
}

export async function importCsv(file: File): Promise<{
  imported: number;
  failed: number;
  total: number;
  errors: { row: number; error: string }[];
}> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/integrations/csv/import`, {
    method: "POST",
    credentials: "same-origin",
    body: fd,
  });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* ignore */
    }
    throw new ApiClientError(res.status, body?.error.code ?? "HTTP_ERROR", body?.error.message ?? "Import failed");
  }
  return (await res.json()) as {
    imported: number;
    failed: number;
    total: number;
    errors: { row: number; error: string }[];
  };
}

export function useApiMutation<TData, TVariables, TError extends ApiClientError, TContext = unknown>(
  mutationFn: (vars: TVariables) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, TError, TVariables, TContext>, "mutationFn" | "onError" | "onSuccess" | "onSettled">
) {
  const { showToast } = useToast();
  return useMutation<TData, TError, TVariables, TContext>({
    mutationFn,
    ...options,
    onError: (_error, _variables, _context) => {
      showToast(_error.message, "error");
    },
    onSuccess: (_data, _variables, _context) => {
      // success handled by caller if needed
    },
    onSettled: (_data, _error, _variables, _context) => {
      // settled handled by caller if needed
    },
  });
}