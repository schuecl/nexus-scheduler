import { useState } from "react";
import { useSearchParams, Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Link as MuiLink, Paper, Stack, TextField, Typography } from "@mui/material";
import LockResetIcon from "@mui/icons-material/LockReset";
import { apiFetch } from "../api/client";

// Also how an admin-provisioned local account (no password yet) sets
// its first password — issuing a reset link is the only way a local
// account's password is ever set (§4).
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (newPassword !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/auth/local/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      });
      setDone(true);
    } catch {
      setError("This reset link is invalid or has expired — request a new one from the sign-in page.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
      <Paper sx={{ p: 4, width: 400 }}>
        <Stack spacing={2}>
          <Typography variant="h5" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <LockResetIcon fontSize="large" /> Set a new password
          </Typography>
          {!token && <Alert severity="error">No reset token in this link.</Alert>}
          {done ? (
            <>
              <Alert severity="success">Password set. You can sign in now.</Alert>
              <MuiLink component={RouterLink} to="/login">
                Go to sign in
              </MuiLink>
            </>
          ) : (
            <>
              <TextField
                label="New password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                helperText="At least 12 characters"
                fullWidth
              />
              <TextField
                label="Confirm password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                fullWidth
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button
                variant="contained"
                startIcon={<LockResetIcon />}
                disabled={!token || !newPassword || submitting}
                onClick={() => void submit()}
              >
                Set password
              </Button>
            </>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
