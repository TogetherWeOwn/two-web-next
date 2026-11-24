# All-off Kit cutover and Hono undo

The [XFS qualification workflow](../.github/workflows/xfs-qualification.yml)
tests the Kit build with every route family off. It preserves the exact facade,
adapter, and asset bytes from that run together with a pure Hono build compiled
for the same database readiness profile. The packet manifest binds both file
trees to the source SHA, root and Kit configuration digests, migration journal,
run ID, and run attempt.

On `main`, dispatch XFS qualification with `qualify_cutover: true` to keep
the packet from that exact attempt for 30 days. The packet identifies the
qualified bytes. Isolated Worker staging and protected deployment selection
require their own checks and evidence.
