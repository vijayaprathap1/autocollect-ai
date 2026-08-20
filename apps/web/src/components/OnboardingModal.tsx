import { useState, useEffect, ReactNode } from "react";
import { Button, Card, Badge } from "@/components/ui";
import { useMe } from "@/lib/me";
import type { MeResponse } from "@/lib/api";

const STORAGE_KEY = "autocollect.onboarding.completed";

export type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
  checkComplete: (me: MeResponse) => boolean;
  href?: string;
};

const STEPS: OnboardingStep[] = [
  {
    id: "source",
    title: "Connect your invoicing source",
    description: "Link Stripe, QuickBooks Online, or upload a CSV to import invoices.",
    checkComplete: (me) => Boolean(me.tenant?.invoiceCount && me.tenant.invoiceCount > 0),
    href: "/settings",
    action: (
      <div className="space-y-3">
        <Button onClick={() => window.location.href = "/settings#integrations"}>Go to Integrations</Button>
        <p className="text-sm text-muted">Or upload a CSV from the Invoices page</p>
      </div>
    ),
  },
  {
    id: "templates",
    title: "Approve reminder templates",
    description: "Review and approve the default email templates for your dunning sequence.",
    checkComplete: (me) => Boolean(me.tenant && !me.tenant.hasUnapprovedTemplates && me.templates.approvedTemplates > 0),
    href: "/templates",
    action: <Button onClick={() => window.location.href = "/templates"}>Review Templates</Button>,
  },
  {
    id: "workflow",
    title: "Enable your dunning workflow",
    description: "Turn on the automated sequence so reminders send on schedule.",
    checkComplete: (me) => Boolean(me.tenant?.workflowEnabled),
    href: "/workflows",
    action: <Button onClick={() => window.location.href = "/workflows"}>Open Workflows</Button>,
  },
  {
    id: "demo",
    title: "Try with sample data (optional)",
    description: "Populate your workspace with demo invoices and replies to explore every screen instantly.",
    checkComplete: () => true,
    action: (
      <Button variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent("onboarding:load-demo"))}>
        Load demo data
      </Button>
    ),
  },
];

export function OnboardingModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const me = useMe();
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (isOpen) {
      const firstIncomplete = STEPS.findIndex((s) => !s.checkComplete(me));
      setCurrentStep(firstIncomplete >= 0 ? firstIncomplete : STEPS.length - 1);
    }
  }, [isOpen, me]);

  // Auto-close when all required steps (first 3) are complete
  useEffect(() => {
    if (isOpen && STEPS.slice(0, 3).every((s) => s.checkComplete(me))) {
      localStorage.setItem(STORAGE_KEY, "true");
      onClose();
    }
  }, [isOpen, me, onClose]);

  if (!isOpen) return null;

  const step = STEPS[currentStep];
  const doneCount = STEPS.filter((s) => s.checkComplete(me)).length;

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      localStorage.setItem(STORAGE_KEY, "true");
      onClose();
    }
  };

  const handleSkip = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-surface p-6 shadow-xl animate-in fade-in zoom-in-95">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Welcome to AutoCollect AI</h2>
          <button onClick={handleSkip} className="text-muted hover:text-ink" aria-label="Skip onboarding">
            ✕
          </button>
        </div>

        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">Setup progress</span>
            <span className="text-muted">{doneCount}/{STEPS.length} steps complete</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <Card className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone={step.checkComplete(me) ? "paid" : "open"}>{step.id}</Badge>
            <h3 className="text-lg font-semibold">{step.title}</h3>
          </div>
          <p className="mb-4 text-sm text-muted">{step.description}</p>
          {step.action}
        </Card>

        <div className="flex items-center justify-between">
          {currentStep > 0 && (
            <Button variant="ghost" onClick={() => setCurrentStep(currentStep - 1)}>
              Back
            </Button>
          )}
          <div className="flex gap-2">
            {currentStep < STEPS.length - 1 ? (
              <>
                <Button variant="secondary" onClick={handleSkip}>
                  Skip for now
                </Button>
                <Button onClick={handleNext}>
                  {step.checkComplete(me) ? "Next step" : "Complete this step"}
                </Button>
              </>
            ) : (
              <Button onClick={handleNext}>Finish</Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          <span className="w-3 h-3 rounded-full bg-green-500" />
          <span>Done</span>
          <span className="w-3 h-3 rounded-full bg-amber-500" />
          <span>In progress</span>
          <span className="w-3 h-3 rounded-full bg-slate-300" />
          <span>Pending</span>
        </div>
      </div>
    </div>
  );
}

export function shouldShowOnboarding(me: MeResponse): boolean {
  if (!me.tenant) return false;
  if (localStorage.getItem(STORAGE_KEY) === "true") return false;
  return STEPS.slice(0, 3).some((s) => !s.checkComplete(me));
}