import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import { Menu, Radio } from "lucide-react";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "true" : "false");
    } catch {}
  }, [collapsed]);

  return (
    <div className="app-shell">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#090b13]/45 backdrop-blur-sm animate-[overlay-enter_220ms_ease-out_both] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />

      <main
        className={
          "h-screen overflow-y-auto p-4 pt-24 md:pt-6 md:p-7 transition-[margin,padding] duration-300 ease-out " +
          (collapsed ? "md:ml-[88px]" : "md:ml-[264px]")
        }
      >
        <header className="glass-surface fixed left-3 right-3 top-3 z-30 flex h-14 items-center justify-between rounded-2xl px-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-xl p-2 text-[var(--foreground)] transition-[transform,background-color] duration-200 hover:bg-[var(--glass-hover)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-2">
            <img src="/omniark.svg" alt="" width="22" height="22" className="h-[22px] w-[22px]" />
            <span className="text-sm font-bold tracking-tight text-[var(--foreground)]">OmniArk</span>
          </div>
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--info)]/10 text-[var(--info)]">
            <Radio className="h-4 w-4" aria-hidden="true" />
          </span>
        </header>

        <div key={location.pathname} className="page-enter mx-auto max-w-[1720px] pb-8"><Outlet /></div>
      </main>
    </div>
  );
}
