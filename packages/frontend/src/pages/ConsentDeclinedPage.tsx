import { Link as RouterLink } from "react-router-dom";
import { Box, Link as MuiLink, Paper, Stack, Typography } from "@mui/material";
import BlockIcon from "@mui/icons-material/Block";

// Landed on by rejecting the login-screen consent banner (§40) — a dead
// end by design: there is no form here, only a way back to try again.
// Reaching this page never touched an account, so there's nothing to
// audit here (acceptance is logged in LoginPage/auth.ts; this is just
// where a "no" goes).
export function ConsentDeclinedPage() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
      <Paper sx={{ p: 4, width: 440 }}>
        <Stack spacing={2} alignItems="center">
          <BlockIcon fontSize="large" color="error" />
          <Typography variant="h5" textAlign="center">
            You must accept the terms to proceed
          </Typography>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            Access to this system requires accepting the notice shown on the sign-in screen.
          </Typography>
          <MuiLink component={RouterLink} to="/login" variant="body2">
            Back to sign in
          </MuiLink>
        </Stack>
      </Paper>
    </Box>
  );
}
