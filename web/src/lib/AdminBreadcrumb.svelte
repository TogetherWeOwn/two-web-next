<script lang="ts">
// Compact upper-page breadcrumb for the event/featured editors, the Kit twin
// of AdminBreadcrumb in src/admin/pages/shell.tsx. Constant routes and
// labels only: editor titles never appear here, so hostile content cannot
// select a section or destination. Native anchors, so keyboard/no-JS
// navigation and the existing beforeunload draft guard apply unchanged.
let { section }: { section: "/admin/events" | "/admin/featured" } = $props();
</script>

<nav class="crumbs" aria-label="Breadcrumb">
  <a href="/admin">Dashboard</a>
  <span aria-hidden="true"> / </span>
  <a href={section}>{section === "/admin/events" ? "Events" : "Featured"}</a>
</nav>
