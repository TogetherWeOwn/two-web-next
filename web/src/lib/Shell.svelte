<script lang="ts">
import type { Snippet } from "svelte";
import SiteFooter from "#lib/SiteFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";

let {
  title,
  canonical,
  robots,
  description,
  shareTitle,
  exactTitle,
  theme,
  leafCss,
  activeNav,
  mainClass,
  loginReturnTo = null,
  accountChrome,
  hideAccount = false,
  restoredWrite = null,
  children,
}: {
  title: string;
  canonical?: string;
  robots?: string;
  description?: string | null;
  shareTitle?: string;
  exactTitle?: string;
  theme: "home" | "event" | "content" | "join" | "profile" | "schedule";
  /** Inlined leaf CSS for the content shell; see SiteMetadata for why this
    arrives as load data instead of an import. */
  leafCss?: string;
  activeNav?: "home" | "events" | "leaderboard";
  mainClass?: string;
  loginReturnTo?: string | null;
  /** Explicitly supplied session-aware chrome; the static shell never reads session state. */
  accountChrome?: Snippet;
  /** Drop the account area entirely, as Hono account={false} does on sessionless pages. */
  hideAccount?: boolean;
  /** Restored-write notice from the root layout data: renders the "you
    signed in again" banner first inside <main>, exactly as Hono's
    expiredWriteBanner middleware injects it. The destination is never
    rendered — the banner keeps its copy with no link — so a hostile value
    stays inert. Bytes are twinned deliberately (never imported from the
    .tsx): importing the Hono screen would bundle the JSX runtime into the
    Kit worker, and the acceptance suite pins both copies byte-identical. */
  restoredWrite?: string | null;
  children: Snippet;
} = $props();

const themeClass = $derived(theme === "home" ? "homepage-theme" : `${theme}-theme`);
// Content leaves are styled solely by the inlined leaf block (Hono parity):
// no Tailwind utilities here, so the served page needs nothing from the
// root-layout stylesheet the hook strips (transformContentLeafChunk). Every
// other theme keeps the Open Lobby chrome below.
const shellClass = $derived(
  theme === "content"
    ? `base-theme ${themeClass}`
    : `base-theme bg-lobby-surface font-sans text-lobby-ink ${themeClass}`,
);
</script>

<SiteMetadata {title} {canonical} {robots} {description} {shareTitle} {exactTitle} {theme} {leafCss} />
<!-- Open Lobby chrome: colours resolve through src/app.css semantic tokens
  (bg-lobby-*/text-lobby-*/font-sans); no hard-coded palette values here. A
  restyle is a token swap in that one file. The content theme is the
  exception: it renders leaf-CSS classes only (see shellClass). -->
<div class={shellClass} data-theme={theme}>
  <SiteHeader {activeNav} {loginReturnTo} {accountChrome} {hideAccount} />
  <main class={mainClass} id="main" tabindex="-1">{#if restoredWrite}<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>{/if}{@render children()}</main>
  <SiteFooter {theme} />
</div>
