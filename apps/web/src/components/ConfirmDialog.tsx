import { useEffect, useCallback } from "react";
import { Button } from "@/components/ui";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary" | "secondary";
  loading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && !loading) onConfirm();
  }, [onClose, onConfirm, loading]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    // Prevent body scroll
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "unset";
    };
  }, [handleKeyDown]);

  const confirmStyles: Record<string, string> = {
    danger: "bg-red-600 hover:bg-red-700 text-white",
    primary: "bg-primary hover:bg-primary-hover text-white",
    secondary: "bg-surface border border-slate-200 text-ink hover:bg-slate-50",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-surface p-6 shadow-xl animate-in fade-in zoom-in-95">
        <h3 className="mb-2 text-lg font-semibold">{title}</h3>
        <p className="mb-6 text-sm text-muted">{message}</p>

        <div className="flex justify-end gap-3">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2"
          >
            {cancelText}
          </Button>
          <Button
            className={`${confirmStyles[variant] || confirmStyles.danger} px-4 py-2`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Processing..." : confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Hook for easier usage
import { useState as useReactState } from "react";

export function useConfirmDialog() {
  const [dialogState, setDialogState] = useReactState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant?: "danger" | "primary" | "secondary";
    confirmText?: string;
    cancelText?: string;
    loading?: boolean;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const open = useCallback((
    title: string,
    message: string,
    onConfirm: () => void,
    options?: {
      variant?: "danger" | "primary" | "secondary";
      confirmText?: string;
      cancelText?: string;
    }
  ) => {
    setDialogState({
      isOpen: true,
      title,
      message,
      onConfirm,
      variant: options?.variant,
      confirmText: options?.confirmText,
      cancelText: options?.cancelText,
      loading: false,
    });
  }, []);

  const close = useCallback(() => {
    setDialogState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    setDialogState((prev) => ({ ...prev, loading }));
  }, []);

  return {
    dialogState,
    open,
    close,
    setLoading,
    ConfirmDialog: () => (
      <ConfirmDialog
        isOpen={dialogState.isOpen}
        onClose={close}
        onConfirm={dialogState.onConfirm}
        title={dialogState.title}
        message={dialogState.message}
        confirmText={dialogState.confirmText}
        cancelText={dialogState.cancelText}
        variant={dialogState.variant}
        loading={dialogState.loading}
      />
    ),
  };
}