<footer class="ember-footer">
  <div class="footer-content">
    <p>Together We Own · adult gaming community · founded&nbsp;1998</p>
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

  .ember-footer {
    border-top: 1px solid var(--two-color-hair-1);
    color: var(--two-color-text-tertiary);
    font-size: var(--two-font-size-small);
    padding: var(--two-space-7) 44px;
  }

  .footer-content {
    align-items: center;
    display: flex;
    gap: var(--two-space-6);
    justify-content: space-between;
    margin: 0 auto;
    max-width: var(--two-layout-container);
  }

  p { margin: 0; }
  nav { display: flex; flex-wrap: wrap; gap: var(--two-space-6); }
  a { color: inherit; }
  a:focus-visible { outline: 2px solid var(--ember); outline-offset: 3px; }

  @media (max-width: 820px) {
    .footer-content { align-items: flex-start; flex-direction: column; }
  }

  @media (forced-colors: active) {
    .ember-footer { border-color: CanvasText; }
    a:focus-visible { outline-color: Highlight; }
  }
</style>
