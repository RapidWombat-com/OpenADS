import { useMutation } from "@tanstack/react-query";
import { startGoogleConnect } from "@/client/lib/sources";

/** Starts Google's consent for Google Ads (Connect and Reconnect buttons). */
export function useGoogleConnect() {
  return useMutation({ mutationFn: startGoogleConnect });
}
