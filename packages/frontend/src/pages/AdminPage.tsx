import { Typography } from "@mui/material";
import { useAuth } from "../context/AuthContext";

export function AdminPage() {
  const { user } = useAuth();

  if (user?.role !== "ADMIN") {
    return <Typography color="error">Admin role required.</Typography>;
  }

  return (
    <>
      <Typography variant="h4" gutterBottom>
        Admin
      </Typography>
      <Typography color="text.secondary">
        User/role/Team management, branding, classification taxonomy, SMTP, cost rates, and audit
        log access (REQUIREMENTS §4-§8) land here.
      </Typography>
    </>
  );
}
