import { Users, Activity, CheckCircle, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

interface StatsData {
  accounts: { active: number; total: number };
  requests: number;
  successRate: number;
  totalTokens: number;
}

interface StatsCardsProps {
  data?: StatsData;
}

const defaultData: StatsData = {
  accounts: { active: 0, total: 0 },
  requests: 0,
  successRate: 0,
  totalTokens: 0,
};

export default function StatsCards({ data = defaultData }: StatsCardsProps) {
  const stats = [
    {
      label: "Accounts",
      value: `${data.accounts.active}/${data.accounts.total}`,
      subtitle: `active`,
      icon: Users,
      color: "text-[var(--chart-2)]",
      bgColor: "bg-[var(--chart-2)]/10",
    },
    {
      label: "Requests",
      value: data.requests.toLocaleString(),
      subtitle: "All time",
      icon: Activity,
      color: "text-[var(--chart-3)]",
      bgColor: "bg-[var(--chart-3)]/10",
    },
    {
      label: "Success Rate",
      value: `${data.successRate}%`,
      subtitle: "All time",
      icon: CheckCircle,
      color: "text-[var(--success)]",
      bgColor: "bg-[var(--success)]/10",
    },
    {
      label: "Total Tokens",
      value: formatTokens(data.totalTokens),
      subtitle: "All time",
      icon: Zap,
      color: "text-[var(--warning)]",
      bgColor: "bg-[var(--warning)]/10",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat, index) => (
        <Card
          key={stat.label}
          className="group relative overflow-hidden"
          style={{ animation: "page-enter 420ms cubic-bezier(0.2, 0.75, 0.2, 1) both", animationDelay: `${index * 55}ms` }}
        >
          <span className={`absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl ${stat.bgColor}`} />
          <CardContent className="relative p-5">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted-foreground)]">
                  {stat.label}
                </p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-[var(--foreground)] tabular-nums">
                  {stat.value}
                </p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {stat.subtitle}
                </p>
              </div>
              <div className={`rounded-2xl border border-white/10 p-3 ${stat.bgColor} transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}>
                <stat.icon className={`h-5 w-5 ${stat.color}`} aria-hidden="true" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
