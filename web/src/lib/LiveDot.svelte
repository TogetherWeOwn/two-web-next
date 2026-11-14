<script lang="ts">
let { kind = "live" }: { kind?: "live" | "presence" } = $props();
</script>

<!-- The containing text must describe the live or presence state. -->
<span class="live-dot" class:presence={kind === "presence"} aria-hidden="true"></span>

<style>
  .live-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--live);
  }

  .presence {
    background: var(--ok);
  }

  @media (forced-colors: active) {
    .live-dot {
      background: CanvasText;
    }
  }
</style>
