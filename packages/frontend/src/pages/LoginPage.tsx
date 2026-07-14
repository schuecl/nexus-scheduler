import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Divider,
  InputAdornment,
  Link as MuiLink,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import LoginIcon from "@mui/icons-material/Login";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import SendIcon from "@mui/icons-material/Send";
import PersonIcon from "@mui/icons-material/Person";
import LockIcon from "@mui/icons-material/Lock";
import PolicyIcon from "@mui/icons-material/Policy";
import CheckIcon from "@mui/icons-material/Check";
import BlockIcon from "@mui/icons-material/Block";
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
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  // Reset on every mount (no persistence across reloads) — a consent
  // banner that gates access is expected to be shown every time the
  // login screen is reached, not acknowledged once and remembered (§40).
  const [consentAccepted, setConsentAccepted] = useState(false);

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

  const handleAcceptConsent = async () => {
    // Best-effort: a failure to record the audit event shouldn't be the
    // reason a legitimate user can't reach the login form.
    await apiFetch("/auth/consent-accept", { method: "POST" }).catch(() => undefined);
    setConsentAccepted(true);
  };

  const handleRejectConsent = () => {
    navigate("/consent-declined", { replace: true });
  };

  const consentGateActive =
    settings.consentBannerEnabled && settings.consentBannerRequireAcceptReject && !consentAccepted;

  if (consentGateActive) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
        <Paper sx={{ p: 4, width: 480 }}>
          <Stack spacing={3}>
            <Stack spacing={1} alignItems="center">
              <PolicyIcon fontSize="large" color="warning" />
              <Typography variant="h5" textAlign="center">
                {settings.consentBannerTitle || "Consent Required"}
              </Typography>
            </Stack>
            {settings.consentBannerBody && (
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                {settings.consentBannerBody}
              </Typography>
            )}
            <Stack direction="row" spacing={2} justifyContent="center">
              <Button variant="outlined" color="error" startIcon={<BlockIcon />} onClick={handleRejectConsent}>
                Reject
              </Button>
              <Button variant="contained" startIcon={<CheckIcon />} onClick={() => void handleAcceptConsent()}>
                Accept
              </Button>
            </Stack>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", mt: 8 }}>
      {settings.consentBannerEnabled && (
        <Paper variant="outlined" sx={{ p: 2, width: 400, mb: 2 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <PolicyIcon fontSize="small" color="warning" />
              <Typography variant="subtitle2">{settings.consentBannerTitle || "Notice"}</Typography>
            </Stack>
            {settings.consentBannerBody && (
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>
                {settings.consentBannerBody}
              </Typography>
            )}
          </Stack>
        </Paper>
      )}
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

          <Button variant="contained" size="large" startIcon={<LoginIcon />} onClick={login}>
            Continue with SSO
          </Button>

          <Divider>or</Divider>

          {!forgotOpen ? (
            <Stack spacing={2}>
              <TextField
                label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                fullWidth
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <PersonIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                onKeyDown={(e) => e.key === "Enter" && void handleLocalLogin()}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <LockIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button
                variant="outlined"
                startIcon={<LockOpenIcon />}
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
                  <Button
                    variant="outlined"
                    startIcon={<SendIcon />}
                    disabled={!forgotEmail}
                    onClick={() => void handleForgotPassword()}
                  >
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
