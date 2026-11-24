// Ported from OpenSEO (MIT, © Ben Senescu): src/client/components/Sidebar.tsx,
// reduced to OpenADS navigation and project switcher (no accounts or chat).
import { Link } from "@tanstack/react-router";
import { FolderKanban, LayoutDashboard, Plug } from "lucide-react";
import { ProjectSwitcher } from "@/client/features/projects/ProjectSwitcher";
import { ThemePreferenceRadio } from "@/client/components/ThemePreferenceRadio";
import {
  Sidebar as UiSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/client/components/ui/sidebar";

const navButtonClass =
  "relative text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:before:absolute data-active:before:inset-y-1 data-active:before:left-0 data-active:before:w-[3px] data-active:before:rounded-r-full data-active:before:bg-primary";

export function BrandMark() {
  return (
    <span
      aria-hidden
      className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
    >
      <svg viewBox="0 0 32 32" className="size-4" fill="currentColor">
        <path d="M6 25h5v-9H6zm7.5 0h5V8h-5zm7.5 0h5V13h-5z" />
      </svg>
    </span>
  );
}

export function AppSidebar() {
  const { setOpenMobile } = useSidebar();

  return (
    <UiSidebar variant="inset" collapsible="offcanvas" className="md:!p-0">
      <SidebarHeader className="gap-0 px-3 pt-3 pb-1">
        <Link
          to="/"
          onClick={() => setOpenMobile(false)}
          className="flex items-center gap-2 rounded-md px-1 pb-2 text-base font-semibold text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <BrandMark />
          OpenADS
        </Link>
        <ProjectSwitcher onCloseDrawer={() => setOpenMobile(false)} />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Main navigation">
          <SidebarGroup className="py-1">
            <SidebarGroupLabel className="h-7 tracking-wider text-sidebar-foreground/40 uppercase">
              Reporting
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <Link
                    to="/"
                    search={true}
                    activeOptions={{ exact: true, includeSearch: false }}
                    onClick={() => setOpenMobile(false)}
                    className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    {({ isActive }) => (
                      <SidebarMenuButton
                        render={<span />}
                        isActive={isActive}
                        className={navButtonClass}
                      >
                        <LayoutDashboard className="size-4" />
                        <span>Overview</span>
                      </SidebarMenuButton>
                    )}
                  </Link>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <Link
                    to="/projects"
                    activeOptions={{ exact: false, includeSearch: false }}
                    onClick={() => setOpenMobile(false)}
                    className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    {({ isActive }) => (
                      <SidebarMenuButton
                        render={<span />}
                        isActive={isActive}
                        className={navButtonClass}
                      >
                        <FolderKanban className="size-4" />
                        <span>Projects</span>
                      </SidebarMenuButton>
                    )}
                  </Link>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <Link
                    to="/sources"
                    activeOptions={{ exact: false, includeSearch: false }}
                    onClick={() => setOpenMobile(false)}
                    className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    {({ isActive }) => (
                      <SidebarMenuButton
                        render={<span />}
                        isActive={isActive}
                        className={navButtonClass}
                      >
                        <Plug className="size-4" />
                        <span>Sources</span>
                      </SidebarMenuButton>
                    )}
                  </Link>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>

      <SidebarFooter className="gap-1.5 border-t border-sidebar-border px-3 pb-safe">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-sidebar-foreground/60">Theme</span>
          <ThemePreferenceRadio />
        </div>
        <p className="px-0.5 text-[11px] text-sidebar-foreground/45 tabular-nums">
          v{__OPENADS_VERSION__}
        </p>
      </SidebarFooter>
    </UiSidebar>
  );
}
