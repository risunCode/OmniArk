import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Users,
  Cpu,
  Settings as SettingsIcon,
  Activity,
  Sliders,
  Globe,
  Filter,
  Plug,
  LogOut,
  X,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useWsStatus } from "@/hooks/useWebSocket";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "OVERVIEW",
    items: [
      { label: "Dashboard", path: "/", icon: LayoutDashboard },
      { label: "Requests", path: "/requests", icon: Activity },
    ],
  },
  {
    title: "ACCOUNTS",
    items: [
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
    ],
  },
  {
    title: "TOOLS",
    items: [
      { label: "Integration", path: "/integration", icon: Plug },
    ],
  },
  {
    title: "PROXY",
    items: [
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe },
      { label: "Filter Rules", path: "/filter-rules", icon: Filter },
      { label: "Proxy Settings", path: "/settings", icon: Sliders },
    ],
  },
];

interface SidebarProps {
  onLogout?: () => void;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ onLogout, open, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  useEffect(() => {
    onClose?.();
  }, [location.pathname]);

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--success)", label: "Live" }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "Connecting" }
        : { color: "var(--error)", label: "Offline" };

  return (
    <aside
      className={cn(
        "fixed left-3 top-3 z-50 flex h-[calc(100vh-1.5rem)] flex-col rounded-[1.5rem] border border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] shadow-[18px_18px_48px_rgba(1,3,12,0.14)] backdrop-blur-2xl transition-[width,transform] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] md:left-3",
        collapsed ? "w-[64px]" : "w-[240px]",
        open ? "translate-x-0" : "-translate-x-[calc(100%+1rem)] md:translate-x-0"
      )}
    >
      {/* Logo */}
      <div className={cn(
        "relative mx-3 mt-2 border-b border-[var(--sidebar-border)] px-1 pb-4 pt-2",
        collapsed ? "flex items-center justify-center" : "flex items-center justify-between"
      )}>
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] shadow-[var(--glow)]"><img src="/omniark.svg" alt="OmniArk" width="24" height="24" className="h-6 w-6" /></span>
          {!collapsed && (
            <div>
              <h1 className="text-sm font-bold tracking-tight text-[var(--foreground)]">OmniArk</h1>
              <span className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: wsMeta.color,
                    boxShadow: `0 0 6px ${wsMeta.color}`,
                  }}
                />
                {wsMeta.label}
              </span>
            </div>
          )}
        </div>
        {onClose && !collapsed && (
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] md:hidden"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Floating toggle button — sits on the right edge of sidebar */}
        <button
          onClick={onToggleCollapse}
          className="glass-surface absolute -right-3 top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-xl text-[var(--muted-foreground)] transition-[transform,color,border-color] duration-200 hover:scale-110 hover:text-[var(--foreground)] hover:border-[var(--primary)]/50 md:flex"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className={cn("flex-1 overflow-y-auto py-5", collapsed ? "px-2" : "px-3")}>
        {navSections.map((section) => (
          <div key={section.title} className="mb-7">
            {!collapsed && (
              <h2 className="text-[10px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wider px-3 mb-2">
                {section.title}
              </h2>
            )}
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.path} className="motion-pop" style={{ animationDelay: `${section.items.indexOf(item) * 35}ms` }}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex items-center gap-3 rounded-xl text-sm transition-[background-color,color,transform] duration-200",
                        collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5",
                        isActive
                          ? "bg-[var(--primary)]/12 text-[var(--primary)] font-semibold before:absolute before:left-0 before:h-5 before:w-[3px] before:rounded-full before:bg-[var(--primary)] before:shadow-[0_0_12px_var(--primary)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--glass-hover)] hover:text-[var(--foreground)]"
                      )
                    }
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-105" />
                    {!collapsed && item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom Settings, Theme & Logout */}
      <div className={cn("mx-3 space-y-1 border-t border-[var(--sidebar-border)] px-0 pb-2 pt-3", collapsed && "mx-2 px-0")}>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex w-full items-center gap-3 rounded-xl text-sm text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-200 hover:bg-[var(--glass-hover)] hover:text-[var(--foreground)] active:scale-[0.98]",
            collapsed ? "px-2 py-2 justify-center" : "px-3 py-2"
          )}
          aria-label="Toggle theme"
          title={collapsed ? (theme === "dark" ? "Light Mode" : "Dark Mode") : undefined}
        >
          {theme === "dark" ? <Sun className="w-4 h-4 flex-shrink-0" /> : <Moon className="w-4 h-4 flex-shrink-0" />}
          {!collapsed && (theme === "dark" ? "Light Mode" : "Dark Mode")}
        </button>
        {onLogout && (
          <button
            onClick={onLogout}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl text-sm text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-200 hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] active:scale-[0.98]",
              collapsed ? "px-2 py-2 justify-center" : "px-3 py-2"
            )}
            title={collapsed ? "Logout" : undefined}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            {!collapsed && "Logout"}
          </button>
        )}
      </div>
    </aside>
  );
}
