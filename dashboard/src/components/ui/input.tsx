import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] px-3 py-1 text-sm text-[var(--foreground)] shadow-inner shadow-black/5 backdrop-blur-xl transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--primary)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/30 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
