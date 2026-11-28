<footer class="ember-footer">
  <div class="footer-content">
    <p>Together We Own · adult gaming community</p>
    <nav aria-label="Footer">
      <a href="/about">About</a>
      <a href="/faq">FAQ</a>
      <a href="/rules">House rules</a>
      <a href="/privacy">Privacy</a>
    </nav>
  </div>
</footer>

<style>
  @import "../../../vendor/design-kit/tokens.css";

  footer.ember-footer {
    background: var(--two-color-bg-canvas);
    border-top: 1px solid var(--two-color-hair-1);
    color: var(--two-color-text-tertiary);
    font-size: var(--two-font-size-small);
    padding: var(--two-space-7) var(--two-layout-gutter-wide) 44px;
    text-align: left;
  }

  .footer-content {
    align-items: center;
    display: flex;
    gap: var(--two-space-6);
    justify-content: space-between;
    margin: 0 auto;
    max-width: calc(var(--two-layout-container) - 2 * var(--two-layout-gutter-wide));
  }

  .footer-content p { color: inherit; margin: 0; }
  footer.ember-footer nav { display: flex; flex-wrap: wrap; gap: var(--two-space-5); justify-content: normal; margin-top: 0; }
  footer.ember-footer a { align-items: center; color: var(--two-color-text-link); display: inline-flex; min-height: var(--two-size-target-min); text-decoration: none; }
  footer.ember-footer a:hover, footer.ember-footer a:focus-visible { text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--two-color-focus-ring); outline-offset: 3px; }

  @media (max-width: 820px) {
    footer.ember-footer { padding-inline: var(--two-layout-gutter-compact); }
    .footer-content { align-items: flex-start; flex-direction: column; gap: var(--two-space-3); }
  }

  @media (forced-colors: active) {
    footer.ember-footer { border-color: CanvasText; }
    a:focus-visible { outline-color: Highlight; }
  }
</style>
