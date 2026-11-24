// Toaster for save feedback. Ported setup from OpenSEO (MIT, © Ben Senescu):
// <Toaster position="bottom-right" mobileOffset={{ bottom: 100 }} />, themed
// with the app's own CSS variables so light/dark follow data-theme. Sonner's
// stylesheet is imported statically (app.css) and its runtime <style> injection
// is removed at build time (vite.config.ts): the CSP allows no un-nonced style.
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useThemePreference } from "@/client/lib/theme";

export function Toaster(props: ToasterProps) {
  const { themePreference } = useThemePreference();
  return (
    <Sonner
      position="bottom-right"
      mobileOffset={{ bottom: 100 }}
      theme={themePreference}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-lg)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
