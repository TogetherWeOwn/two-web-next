# Stock actionlint inventory

This Actions-only helper builds stock actionlint from a checksum-pinned source
archive and Go toolchain, verifies the module cache and unchanged manifests,
then runs the upstream inventory with a checksum-pinned test harness patch.
The patch repairs archive discovery, the source-build SARIF version and a
scoped HTTP fixture; it does not change the actionlint grammar. The script
verifies that grammar files remain unchanged and removes its temporary files.
It does not replace the existing workflow validator or lint project workflows.
Source: [actionlint v1.7.7](https://github.com/rhysd/actionlint/tree/03d0035246f3e81f36aed592ffb4bebf33a03106) (MIT).
