import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock, Sparkles } from "lucide-react";
import { validateApiKey, API_BASE } from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError("Please enter an API key");
      return;
    }

    setLoading(true);
    setError(null);

    const valid = await validateApiKey(key.trim());
    if (valid) {
      localStorage.setItem("api_key", key.trim());
      onLogin();
    } else {
      setError("Invalid API key");
    }
    setLoading(false);
  }

  return (
    <div className="app-shell flex min-h-screen items-center justify-center p-4">
      <Card className="motion-pop w-full max-w-md overflow-hidden">
        <div className="h-1 w-full bg-gradient-to-r from-[var(--chart-2)] via-[var(--primary)] to-[var(--chart-3)]" />
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-[var(--primary)]/25 bg-[var(--primary)]/12 shadow-[var(--glow)]">
            <Lock className="h-6 w-6 text-[var(--primary)]" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl">Welcome to OmniArk</CardTitle>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
            Enter an owner API key to open your proxy command center.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="relative block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--muted-foreground)]"><Sparkles className="h-3 w-3" aria-hidden="true" /> Access Key</span>
              <Input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(null); }}
                placeholder="sk-pool-…"
                className="pr-10 font-mono text-sm"
                name="api-key"
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute bottom-2.5 right-3 rounded-lg p-1 text-[var(--muted-foreground)] transition-[color,background-color] hover:bg-[var(--glass-hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </label>

            {error && (
              <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]" role="alert">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verifying…" : "Open Dashboard"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
