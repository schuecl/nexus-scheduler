import type { SvgIconProps } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";

export type RunStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED";

// One place to map a Run's status to both its icon and color, reused by
// the dashboard, schedule/run history views, and anywhere else a run
// status shows up — the pre-icon code already had this same status set
// duplicated per file for Chip colors; this rides along with that.
const ICONS: Record<RunStatus, typeof CheckCircleOutlineIcon> = {
  PENDING: HourglassEmptyIcon,
  RUNNING: AutorenewIcon,
  SUCCESS: CheckCircleOutlineIcon,
  FAILED: ErrorOutlineIcon,
  CANCELLED: CancelOutlinedIcon,
  SKIPPED: RemoveCircleOutlineIcon,
};

export const RUN_STATUS_COLOR: Record<RunStatus, "default" | "info" | "success" | "error" | "warning"> = {
  PENDING: "default",
  RUNNING: "info",
  SUCCESS: "success",
  FAILED: "error",
  CANCELLED: "warning",
  SKIPPED: "warning",
};

// Same palette as RUN_STATUS_COLOR, just using SvgIcon's own color enum
// (which has no "default") instead of Chip's.
const ICON_COLOR: Record<RunStatus, NonNullable<SvgIconProps["color"]>> = {
  PENDING: "disabled",
  RUNNING: "info",
  SUCCESS: "success",
  FAILED: "error",
  CANCELLED: "warning",
  SKIPPED: "warning",
};

export function RunStatusIcon({ status, ...props }: { status: RunStatus } & SvgIconProps) {
  const Icon = ICONS[status];
  return <Icon fontSize="small" color={ICON_COLOR[status]} {...props} />;
}
