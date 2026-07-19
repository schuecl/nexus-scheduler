import { useQuery } from "@tanstack/react-query";
import { alpha, Box, Stack, Tooltip, Typography, useTheme, type Theme } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { apiFetch } from "../api/client";

type ComponentStatus = "up" | "down" | "stale" | "unconfigured";

interface SystemComponent {
  id: string;
  label: string;
  status: ComponentStatus;
}

interface SystemStatusResponse {
  components: SystemComponent[];
  edges: Array<{ from: string; to: string }>;
  checkedAt: string;
}

const STATUS_LABEL: Record<ComponentStatus, string> = {
  up: "Reachable",
  down: "Unreachable",
  stale: "No recent report",
  unconfigured: "Not configured",
};

// Fixed layout for the six components this app actually models today
// (issue #131): API/Worker on top, everything they depend on below.
// Positions are in a 0-100 x 0-100 coordinate space, drawn via a
// viewBox so the SVG scales to its container rather than needing pixel
// math here.
const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  api: { x: 25, y: 12 },
  worker: { x: 75, y: 12 },
  postgres: { x: 10, y: 75 },
  redis: { x: 30, y: 75 },
  "pdf-service": { x: 50, y: 75 },
  librechat: { x: 70, y: 75 },
  ocr: { x: 90, y: 75 },
};

function useSystemStatus() {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: () => apiFetch<SystemStatusResponse>("/api/system-status"),
    // Matches the Worker's own publish cadence (componentStatusPublisher.ts)
    // — polling faster wouldn't reveal anything new between publishes.
    refetchInterval: 30_000,
  });
}

function statusColor(theme: Theme, status: ComponentStatus): string {
  if (status === "up") return theme.palette.success.main;
  if (status === "down") return theme.palette.error.main;
  // "stale" and "unconfigured" both render muted: neither is an error,
  // and the label below the node says which one it is.
  return theme.palette.text.disabled;
}

function StatusIcon({ status }: { status: ComponentStatus }) {
  if (status === "up") return <CheckCircleIcon fontSize="small" color="success" />;
  if (status === "down") return <CancelIcon fontSize="small" color="error" />;
  return <HelpOutlineIcon fontSize="small" color="disabled" />;
}

// Compact row of status chips — for embedding on the Dashboard, where a
// full flow chart would be too heavy for a summary widget.
// Compact strip for the top of the Admin page: one small
// status-colored square per component. Live operational truth at a
// glance, not navigation — the full node-and-edge map is its own page.
export function SystemStatusSummary() {
  const theme = useTheme();
  const query = useSystemStatus();

  if (query.isLoading) {
    return null; // a strip that pops in beats a loading line at the top of Admin
  }
  if (query.isError || !query.data) {
    return <Typography color="text.secondary">System status unavailable.</Typography>;
  }

  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
      {query.data.components.map((component) => (
        <Tooltip key={component.id} title={STATUS_LABEL[component.status]}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: 0.5,
                bgcolor: statusColor(theme, component.status),
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {component.label}
            </Typography>
          </Stack>
        </Tooltip>
      ))}
    </Stack>
  );
}

// Full live system map (issue #131): every component drawn as a node,
// every connection as a line, colored green/red/grey by the same
// probed-or-published status the API's /api/system-status endpoint
// reports. For the KB Architecture page.
export function SystemStatusGraph() {
  const theme = useTheme();
  const query = useSystemStatus();

  if (query.isLoading) {
    return <Typography color="text.secondary">Loading system status…</Typography>;
  }
  if (query.isError || !query.data) {
    return <Typography color="text.secondary">System status is currently unavailable.</Typography>;
  }

  const { components, edges, checkedAt } = query.data;
  const byId = Object.fromEntries(components.map((c) => [c.id, c]));

  return (
    <Stack spacing={1.5}>
      <svg viewBox="0 0 100 100" width="100%" style={{ maxHeight: 420 }} role="img" aria-label="System component status">
        {edges.map((edge) => {
          const from = NODE_POSITIONS[edge.from];
          const to = NODE_POSITIONS[edge.to];
          if (!from || !to) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={alpha(theme.palette.text.primary, 0.25)}
              strokeWidth={0.4}
            />
          );
        })}
        {components.map((component) => {
          const pos = NODE_POSITIONS[component.id];
          if (!pos) return null;
          const color = statusColor(theme, component.status);
          return (
            <g key={component.id}>
              <circle cx={pos.x} cy={pos.y} r={4.5} fill={theme.palette.background.paper} stroke={color} strokeWidth={1.2} />
              <circle cx={pos.x} cy={pos.y} r={1.6} fill={color} />
              <text
                x={pos.x}
                y={pos.y + 9}
                textAnchor="middle"
                fontSize={3.6}
                fill={theme.palette.text.primary}
              >
                {component.label}
              </text>
            </g>
          );
        })}
      </svg>

      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
        {(["up", "down", "stale", "unconfigured"] as const).map((status) => (
          <Stack key={status} direction="row" spacing={0.5} alignItems="center">
            <StatusIcon status={status} />
            <Typography variant="caption" color="text.secondary">
              {STATUS_LABEL[status]}
            </Typography>
          </Stack>
        ))}
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Last checked {new Date(checkedAt).toLocaleTimeString()}. Postgres, Redis, and the PDF service are probed
        directly by the API; LibreChat and the Worker's own liveness are reported by the Worker itself, so a
        crashed or restarted Worker shows as "{STATUS_LABEL.stale}" instead of a stale last-known value.
      </Typography>

      {byId.worker?.status === "stale" && (
        <Typography variant="caption" color="warning.main">
          The Worker hasn't reported in recently — LibreChat's status below may be out of date.
        </Typography>
      )}
    </Stack>
  );
}
