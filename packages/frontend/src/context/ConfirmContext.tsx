import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from "@mui/material";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  // Most callers are confirming a destructive delete/revoke — default the
  // confirm button to the "error" color for that common case rather than
  // making every call site opt in explicitly.
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

// One shared confirmation dialog for every destructive action in the
// app, rather than a bespoke dialog (or, previously, nothing at all) per
// call site. `await confirm({...})` resolves true/false depending on
// which button the user picked; only one confirmation can be pending at
// a time, which matches every actual use (a single button click).
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleClose = (result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={options !== null} onClose={() => handleClose(false)}>
        <DialogTitle>{options?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{options?.message}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => handleClose(false)}>Cancel</Button>
          <Button
            onClick={() => handleClose(true)}
            color={options?.destructive === false ? "primary" : "error"}
            variant="contained"
            autoFocus
          >
            {options?.confirmLabel ?? "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
