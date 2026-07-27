import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { modelColor } from "@/lib/utils";

interface UsageChartProps {
  data?: any[];
  period?: string;
  colorsByModel?: Record<string, string>;
}

const defaultData: any[] = [];

function formatTokenCount(value: number) {
  const abs = Math.abs(value);
  const format = (num: number) => Number(num.toFixed(2)).toString();

  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${format(value / 1_000)}K`;
  return value.toString();
}

export default function UsageChart({ data = defaultData, colorsByModel = {} }: UsageChartProps) {
  const models = Object.keys(data[0] || {}).filter((k) => k !== "hour" && k !== "label");
  const colors = Object.fromEntries(models.map((model, index) => [model, colorsByModel[model] || modelColor(model, index)]));

  if (data.length === 0) {
    return (
      <div className="flex h-[300px] w-full items-center justify-center rounded-2xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-bg)] text-sm text-[var(--muted-foreground)] backdrop-blur-xl">
        No usage data yet
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            {models.map((model) => (
              <linearGradient key={model} id={`gradient-${model}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors[model]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors[model]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--glass-border)" />
          <XAxis
            dataKey="label"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatTokenCount(Number(value))}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const sorted = [...payload].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
              return (
                <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-3 py-2 shadow-[var(--glass-shadow)] backdrop-blur-xl">
                  <p className="mb-1 text-xs text-[var(--muted-foreground)]">{label}</p>
                  {sorted.map((entry) => (
                    <p key={entry.name} className="my-0.5 text-xs" style={{ color: String(entry.color || "var(--foreground)") }}>
                      {entry.name} : {formatTokenCount(Number(entry.value || 0))}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ color: "var(--muted-foreground)", fontSize: "12px" }}
          />
          {models.map((model) => (
            <Area
              key={model}
              type="monotone"
              dataKey={model}
              stroke={colors[model]}
              fill={`url(#gradient-${model})`}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
