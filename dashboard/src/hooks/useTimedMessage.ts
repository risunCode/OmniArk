import { useCallback, useEffect, useRef, useState } from "react";
import { notifyToast } from "@/components/ui/toast";

export function useTimedMessage<T>(initialValue: T | null = null, defaultDelayMs = 4000) {
  const [message, setMessageState] = useState<T | null>(initialValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearMessage = useCallback(() => {
    clearTimer();
    setMessageState(null);
  }, [clearTimer]);

  const setMessage = useCallback((value: T | null, delayMs = defaultDelayMs) => {
    clearTimer();
    setMessageState(value);
    if (typeof value === "string" && value) notifyToast({ title: value, variant: "info", duration: delayMs });
    if (value !== null && delayMs > 0) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setMessageState(null);
      }, delayMs);
    }
  }, [clearTimer, defaultDelayMs]);

  useEffect(() => clearTimer, [clearTimer]);

  return { message, setMessage, clearMessage };
}
