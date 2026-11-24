# Third-party notices

OpenADS is licensed under the GNU Affero General Public License v3.0 (see
`LICENSE`). It includes source code adapted from the projects below, which
remains available under their MIT License; the notices below must be kept with
those files. Each ported file starts with a comment naming its origin. npm
dependencies keep their own licenses in `node_modules/` and are not listed here.

## OpenSEO

The dashboard design system and shell are ported from OpenSEO
(https://github.com/every-app/open-seo), MIT License:

- `src/client/styles/app.css` (theme tokens and base styles; OpenADS uses a
  green primary and its own theme names)
- `src/client/components/ui/`: `alert`, `alert-dialog`, `badge`, `button`,
  `checkbox`, `combobox` (without chips), `dialog`, `dropdown-menu` (without
  submenus, radio items and shortcuts; plus a link item), `empty`, `input`,
  `input-group` (without textarea), `separator`, `sheet`, `sidebar`,
  `skeleton`, `sonner` (the toaster setup), `spinner`, `table`, `toggle`,
  `toggle-group`, `tooltip`
- `src/client/components/`: `EmptyState`, `ErrorState`, `SegmentedToggle`,
  `ThemePreferenceRadio` (from `ThemePreferenceMenuItems`)
- `src/client/layout/AppShell.tsx`, `src/client/layout/AppSidebar.tsx`
  (from `Sidebar.tsx`), `src/client/lib/theme.ts`,
  `src/client/hooks/use-mobile.ts`

OpenADS changes: no inline `style` attributes (blocked by the strict CSP),
no sidebar cookie, trimmed navigation, and imports adapted to this repository.
The Sources page, Google Ads card and account picker
(`src/client/features/sources/`) follow the UX of OpenSEO's Google connection
card, removal dialog and property picker but are written for OpenADS. The
project switcher (`src/client/features/projects/ProjectSwitcher.tsx`), the
remembered project (`src/client/lib/projects.ts`) and the Projects page follow
OpenSEO's `ProjectSwitcher`, `active-project` and projects page, rewritten for
OpenADS's URL-scoped dashboard.

```
MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn/ui

Many of the OpenSEO components above are shadcn/ui components (base-nova style
on Base UI). `src/client/components/ui/popover.tsx` follows the same pattern,
and the custom Tailwind variants and `no-scrollbar` utility at the top of
`src/client/styles/app.css` are copied from `shadcn/tailwind.css`
(https://github.com/shadcn-ui/ui), MIT License:

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
