<a href="#main">Skip to content</a>

<style>
  a {
    position: fixed;
    top: var(--space-3);
    left: var(--space-3);
    z-index: 1000;
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 14px;
    border-radius: var(--radius-pill);
    background: var(--ember);
    color: var(--on-accent);
    font-family: var(--font-ui);
    font-size: var(--text-small);
    font-weight: var(--font-weight-semibold);
    font-stretch: var(--font-width-button);
    text-decoration: none;
    transform: translateY(-200%);
  }

  a:focus-visible {
    transform: none;
    outline: var(--focus-width) solid var(--focus-ring);
    outline-offset: var(--focus-offset);
  }

  @media (forced-colors: active) {
    a { border: 1px solid ButtonText; }
  }
</style>
