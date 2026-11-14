import assert from "node:assert/strict";

// Compare rendered properties to the actual generated token values, not copied
// palette constants. The probe lets the browser resolve units, fonts and colors.
export async function assertTagStyles(page) {
  const results = await page.evaluate(() => {
    const properties = [
      ["gap", "--space-2"],
      ["paddingTop", "--space-inset-tag-y"],
      ["paddingLeft", "--space-inset-tag-x"],
      ["borderRadius", "--radius-s"],
      ["fontFamily", "--font-data"],
      ["fontSize", "--text-label"],
      ["letterSpacing", "--tracking-label"],
    ];
    const variants = {
      neutral: "--t2",
      live: "--live",
      you: "--ember",
      echo: "--t2",
      ok: "--ok",
      warn: "--warn",
    };
    const failures = [];
    for (const [variant, color] of Object.entries(variants)) {
      const wrapper = document.querySelector(`[data-tag-fixture="${variant}"]`);
      const tag = wrapper?.querySelector(".tag");
      if (!tag) {
        failures.push(`${variant}: missing tag`);
        continue;
      }
      const style = getComputedStyle(tag);
      if (style.display !== "inline-flex" || style.textTransform !== "uppercase") {
        failures.push(`${variant}: layout or text transform differs`);
      }
      const probe = document.createElement("span");
      tag.append(probe);
      for (const [property, token] of [...properties, ["color", color]]) {
        if (!style.getPropertyValue(token).trim()) {
          failures.push(`${variant}: missing ${token}`);
          continue;
        }
        probe.style[property] = `var(${token})`;
        const expected = getComputedStyle(probe)[property];
        if (style[property] !== expected) {
          failures.push(
            `${variant}: ${property} was ${style[property]}, expected ${expected} from ${token}`,
          );
        }
      }
      const outlineToken =
        variant === "neutral" ? "--color-hair2" : variant === "echo" ? "--echo" : color;
      if (!style.getPropertyValue(outlineToken).trim()) {
        failures.push(`${variant}: missing ${outlineToken}`);
      } else {
        probe.style.color = style.color;
        const outline =
          variant === "neutral"
            ? `var(${outlineToken})`
            : variant === "echo"
              ? `color-mix(in srgb, var(${outlineToken}) 50%, transparent)`
              : "color-mix(in srgb, currentColor 45%, transparent)";
        probe.style.boxShadow = `inset 0 0 0 1px ${outline}`;
        if (style.boxShadow !== getComputedStyle(probe).boxShadow) {
          failures.push(`${variant}: outline does not match ${outlineToken}`);
        }
      }
      const dot = tag.querySelector(".dot");
      if (Boolean(dot) !== (variant === "live" || variant === "echo")) {
        failures.push(`${variant}: unexpected dot presence`);
      } else if (dot) {
        if (dot.getAttribute("aria-hidden") !== "true")
          failures.push(`${variant}: dot is not hidden`);
        const dotStyle = getComputedStyle(dot);
        if (
          dotStyle.width !== "7px" ||
          dotStyle.height !== "7px" ||
          dotStyle.borderRadius !== "50%"
        ) {
          failures.push(`${variant}: dot geometry differs`);
        }
        probe.style.color = `var(${variant === "echo" ? "--echo" : color})`;
        if (dotStyle.backgroundColor !== getComputedStyle(probe).color) {
          failures.push(`${variant}: dot color does not match its token`);
        }
      }
      probe.remove();
    }
    return failures;
  });
  assert.deepEqual(results, [], results.join("\n"));
}
