// Admin pages barrel (structural split; zero behavior change). One module per
// screen lives in ./pages/; shared Shell/Field helpers stay in ./pages/shell.
// This file re-exports the historic public names so existing importers keep
// working untouched.

export { ErrorPage, Field } from "./pages/shell";
export { AdminDashboard } from "./pages/dashboard";
export { JoinAttemptPage, JoinAttemptsPage } from "./pages/join-attempts";
export { ActivityLogPage } from "./pages/activity-log";
export { EventsPage } from "./pages/events-list";
export { EventFormPage } from "./pages/event-form";
export { FeaturedPage } from "./pages/featured-list";
export { FeaturedFormPage } from "./pages/featured-form";
