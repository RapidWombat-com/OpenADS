import { useMutation } from "@tanstack/react-query";
import { startMetaConnect } from "@/client/lib/meta";

/** Starts Facebook Login for Meta Ads (Connect and Reconnect buttons); `rerequest` asks again for ads_read. */
export function useMetaConnect() {
  return useMutation({ mutationFn: (options: { rerequest?: boolean } | void) => startMetaConnect(options?.rerequest ?? false) });
}
