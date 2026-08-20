export type TenantTone = "friendly" | "professional" | "firm";

export type UserRole = "owner" | "admin" | "member";

export type IntegrationSource = "stripe" | "qbo" | "csv";
export type IntegrationStatus = "active" | "error" | "disconnected";

export type InvoiceStatus = "open" | "paid" | "void" | "uncollectible" | "paused";
export type InvoiceSource = "stripe" | "csv" | "qbo";

export type MessageChannel = "email" | "sms";
export type MessageStatus = "sent" | "delivered" | "opened" | "clicked" | "bounced" | "failed";

export type ReplyClassification = "dispute" | "promise" | "question" | "junk";

export type WorkflowStep = {
  order: number;
  delayDays: number; // relative to due date; negative = before due
  channel: MessageChannel;
  templateId: string | null;
  condition?: "overdue_only" | "all_open";
};

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  clerkOrgId: string | null;
  emailDomain: string | null;
  tone: TenantTone;
  createdAt: string;
};

export type User = {
  id: string;
  tenantId: string | null;
  clerkUserId: string;
  email: string | null;
  role: UserRole;
};

export type Integration = {
  id: string;
  tenantId: string;
  source: IntegrationSource;
  status: IntegrationStatus;
  settings: Record<string, unknown>;
  createdAt: string;
};

export type Customer = {
  id: string;
  tenantId: string;
  externalId: string | null;
  source: InvoiceSource;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  smsOptOut: boolean;
  createdAt: string;
};

export type Invoice = {
  id: string;
  tenantId: string;
  integrationId: string | null;
  customerId: string | null;
  externalId: string | null;
  source: InvoiceSource;
  amountDue: number; // minor units (cents)
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  status: InvoiceStatus;
  paymentLink: string | null;
  lineItems: unknown[];
  nextStepIndex: number;
  nextStepDueAt: string | null;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Template = {
  id: string;
  tenantId: string;
  stepKey: string;
  subject: string;
  body: string;
  approved: boolean;
  createdAt: string;
};

export type Workflow = {
  id: string;
  tenantId: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  steps: WorkflowStep[];
  createdAt: string;
};

export type Message = {
  id: string;
  tenantId: string;
  invoiceId: string | null;
  stepIndex: number;
  channel: MessageChannel;
  providerMsgId: string | null;
  status: MessageStatus;
  sentAt: string | null;
  createdAt: string;
};

export type Reply = {
  id: string;
  tenantId: string;
  invoiceId: string | null;
  channel: MessageChannel;
  content: string;
  classification: ReplyClassification;
  promiseDate: string | null;
  resolved: boolean;
  createdAt: string;
};

export type AgingBucket = { bucket: string; count: number; amount: number };

export type DashboardSummary = {
  outstandingTotal: number;
  overdueTotal: number;
  recovered30d: number;
  avgDsoDays: number | null;
  aging: AgingBucket[];
  openCount: number;
  paidCount30d: number;
};

export type ApiError = {
  error: { code: string; message: string };
};