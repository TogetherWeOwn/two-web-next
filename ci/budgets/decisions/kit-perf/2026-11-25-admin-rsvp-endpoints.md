# Moderator RSVP endpoint budgets

The pause and reopen POST handlers each add a server-only route to the Kit
manifest. Endpoint-only routes have an empty client asset closure, so the
[admission](2026-11-25-admin-rsvp-endpoints.json) sets both JS and CSS caps to
zero bytes and zero files. Hosted route measurement verifies the built inventory.

Revert the two budget rows and this admission with the two endpoints if the
endpoints are removed from the build.
