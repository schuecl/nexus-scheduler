import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Alert, Avatar, Box, Button, Divider, Link as MuiLink, Paper, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { apiFetch } from "../api/client";

// Two paths, both always available: SSO (the standard path — CAC/PIV is
// handled entirely upstream by Keycloak) and local login (the
// break-glass fallback, REQUIREMENTS §4). Local is never hidden behind
// a flag here — if it's disabled deployment-wide, the API will just
// reject it.
export function LoginPage() {
  const { user, login, localLogin } = useAuth();
  const { settings } = useSettings();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleLocalLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await localLogin(email, password);
    } catch {
      setError("Invalid email or password.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    await apiFetch("/auth/local/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: forgotEmail }),
    }).catch(() => undefined); // response is intentionally identical either way
    setForgotSent(true);
  };

  return (
    <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
      <Paper sx={{ p: 4, width: 400 }}>
        <Stack spacing={3}>
          <Stack spacing={1} alignItems="center">
            {settings.logoUrl && (
              <Avatar src={settings.logoUrl} variant="square" sx={{ width: 56, height: 56 }} />
            )}
            <Typography variant="h6" textAlign="center" color="text.secondary">
              {settings.productName}
            </Typography>
            <Typography variant="h5" textAlign="center">
              Sign in
            </Typography>
          </Stack>

          <Button variant="contained" size="large" onClick={login}>
            Continue with SSO
          </Button>

          <Divider>or</Divider>

          {!forgotOpen ? (
            <Stack spacing={2}>
              <TextField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                onKeyDown={(e) => e.key === "Enter" && void handleLocalLogin()}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button
                variant="outlined"
                disabled={!email || !password || submitting}
                onClick={() => void handleLocalLogin()}
              >
                Sign in with password
              </Button>
              <MuiLink component="button" variant="body2" onClick={() => setForgotOpen(true)} sx={{ alignSelf: "center" }}>
                Forgot password?
              </MuiLink>
            </Stack>
          ) : (
            <Stack spacing={2}>
              {forgotSent ? (
                <Alert severity="success">
                  If that email has a local account, a reset link has been sent.
                </Alert>
              ) : (
                <>
                  <TextField
                    label="Email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    fullWidth
                  />
                  <Button variant="outlined" disabled={!forgotEmail} onClick={() => void handleForgotPassword()}>
                    Send reset link
                  </Button>
                </>
              )}
              <MuiLink component="button" variant="body2" onClick={() => setForgotOpen(false)} sx={{ alignSelf: "center" }}>
                Back to sign in
              </MuiLink>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
