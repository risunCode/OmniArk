import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-[transform,background-color,border-color,box-shadow,color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[0_10px_24px_-12px_var(--primary)] hover:-translate-y-px hover:bg-[var(--accent)] hover:shadow-[0_16px_30px_-13px_var(--primary)]",
        destructive: "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:-translate-y-px hover:brightness-110",
        outline: "border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--foreground)] backdrop-blur-xl hover:-translate-y-px hover:border-[var(--glass-border-strong)] hover:bg-[var(--glass-hover)]",
        secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:-translate-y-px hover:bg-[var(--glass-hover)]",
        ghost: "text-[var(--foreground)] hover:bg-[var(--glass-hover)]",
        link: "text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 min-h-[44px] md:min-h-0",
        sm: "h-8 rounded-md px-3 text-xs min-h-[44px] md:min-h-0",
        lg: "h-10 rounded-md px-8 min-h-[44px] md:min-h-0",
        icon: "h-9 w-9 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
