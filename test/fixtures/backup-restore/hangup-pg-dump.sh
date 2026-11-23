#!/bin/sh
# Simulate interruption after a partial archive write.
for archive do
  :
done
printf 'synthetic partial archive' > "$archive"
kill -HUP "$PPID"
# Force successful exit so a failed signal delivery makes the proof fail.
exit 0
