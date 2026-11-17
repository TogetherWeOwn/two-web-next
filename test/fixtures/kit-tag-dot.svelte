<script lang="ts">
import LiveDot from "../../web/src/lib/LiveDot.svelte";
import Tag from "../../web/src/lib/Tag.svelte";
</script>

<LiveDot />
<LiveDot kind="presence" />
<Tag>Neutral</Tag>
<Tag variant="live" dot>Live</Tag>
<Tag variant="you">You</Tag>
<Tag variant="echo">Echo</Tag>
<Tag variant="echo" dot={false}>Echo explicitly without dot</Tag>
<Tag variant="ok">OK</Tag>
<Tag variant="warn">Warning</Tag>
