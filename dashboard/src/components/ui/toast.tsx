import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const toastEvent = "omniark:toast";

const toastIcons: Record<ToastVariant, LucideIcon> = {
  success: CheckCircle2,
  error: CircleAlert,
  warning: CircleAlert,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.floor(Math.random() * 1_000);
    const item: ToastItem = { ...input, id, variant: input.variant ?? "info" };
    setItems((current) => [...current, item].slice(-5));
    window.setTimeout(() => dismiss(id), input.duration ?? 4_000);
  }, [dismiss]);

  useEffect(() => {
    const handleToast = (event: Event) => {
      const input = (event as CustomEvent<ToastInput>).detail;
      if (input?.title) toast(input);
    };
    window.addEventListener(toastEvent, handleToast);
    return () => window.removeEventListener(toastEvent, handleToast);
  }, [toast]);

  const value = useMemo(() => ({ toast }), [toast]);

  return <ToastContext.Provider value={value}>{children}<div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3" aria-live="polite" aria-atomic="true">{items.map((item) => <Toast key={item.id} item={item} onDismiss={() => dismiss(item.id)} />)}</div></ToastContext.Provider>;
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = toastIcons[item.variant];
  return <div className={cn("pointer-events-auto relative overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] p-4 pr-11 text-[var(--foreground)] shadow-[var(--glass-shadow)] backdrop-blur-2xl", "animate-[toast-enter_360ms_cubic-bezier(0.2,0.75,0.2,1)_both]")}>
    <div className="flex gap-3"><span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl", item.variant === "success" && "bg-[var(--success)]/15 text-[var(--success)]", item.variant === "error" && "bg-[var(--error)]/15 text-[var(--error)]", item.variant === "warning" && "bg-[var(--warning)]/15 text-[var(--warning)]", item.variant === "info" && "bg-[var(--info)]/15 text-[var(--info)]")}><Icon className="h-4 w-4" aria-hidden="true" /></span><div className="min-w-0"><p className="text-sm font-semibold">{item.title}</p>{item.description && <p className="mt-0.5 text-xs leading-5 text-[var(--muted-foreground)]">{item.description}</p>}</div></div>
    <button type="button" onClick={onDismiss} className="absolute right-3 top-3 rounded-lg p-1 text-[var(--muted-foreground)] transition-[color,background-color] hover:bg-[var(--glass-hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" aria-label="Dismiss notification"><X className="h-4 w-4" aria-hidden="true" /></button>
  </div>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) return { toast: () => {} };
  return context;
}

export function notifyToast(input: ToastInput): void {
  window.dispatchEvent(new CustomEvent<ToastInput>(toastEvent, { detail: input }));
}
