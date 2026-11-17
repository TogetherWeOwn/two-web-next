import assert from "node:assert/strict";

// This recognizer only accepts data-only modules. It does not load imports or
// establish that a config is safe to credit; callers must validate the closure.
export function validateDataConfig(text, configPath) {
  const token =
    /\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/|(?:'[^'\\\r\n]*'|"[^"\\\r\n]*")|\/[A-Za-z0-9_.^$*+?|!-]+\/[A-Za-z]*|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|[A-Za-z_$][A-Za-z0-9_$]*|\.\.\.|[{}[\](),:;]/y;
  const tokens = [];
  for (let pos = 0; pos < text.length; ) {
    token.lastIndex = pos;
    const match = token.exec(text);
    assert.ok(match, `${configPath} has unsupported config syntax at ${pos}`);
    pos = token.lastIndex;
    if (!/^(?:\s|\/\/|\/\*)/.test(match[0])) tokens.push(match[0]);
  }
  let i = 0;
  const take = (value) => {
    if (tokens[i] !== value) return false;
    i += 1;
    return true;
  };
  const expect = (value) => assert.ok(take(value), `${configPath} expected ${value}`);
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const string = /^(?:'[^'\\]*'|"[^"\\]*")$/;
  const bindings = new Set();
  expect("import");
  expect("{");
  expect("defineConfig");
  expect("}");
  expect("from");
  assert.ok(
    /^['"]@playwright\/test['"]$/.test(tokens[i++] ?? ""),
    `${configPath} needs Playwright defineConfig`,
  );
  expect(";");
  while (take("import")) {
    const name = tokens[i++];
    assert.ok(
      identifier.test(name ?? "") &&
        !["defineConfig", "undefined"].includes(name) &&
        !bindings.has(name),
      `${configPath} has an invalid import binding`,
    );
    bindings.add(name);
    expect("from");
    assert.ok(
      /^['"]\.\.?\/[^'"\\]+['"]$/.test(tokens[i++] ?? ""),
      `${configPath} needs a relative config import`,
    );
    expect(";");
  }
  const value = (top = false) => {
    if (take("{")) {
      if (take("}")) return;
      do {
        if (top && take("...")) {
          assert.ok(bindings.has(tokens[i++]), `${configPath} has an unsupported config spread`);
        } else {
          const key = tokens[i++];
          assert.ok(
            (identifier.test(key ?? "") || string.test(key ?? "")) &&
              key !== "__proto__" &&
              key !== "'__proto__'" &&
              key !== '"__proto__"',
            `${configPath} has an unsupported property`,
          );
          expect(":");
          value();
        }
        if (take("}")) return;
        expect(",");
        if (take("}")) return;
      } while (true);
    }
    if (take("[")) {
      if (take("]")) return;
      do {
        value();
        if (take("]")) return;
        expect(",");
        if (take("]")) return;
      } while (true);
    }
    assert.ok(
      /^(?:'[^'\\]*'|"[^"\\]*"|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|true|false|null|undefined|\/[A-Za-z0-9_.^$*+?|!-]+\/[A-Za-z]*)$/.test(
        tokens[i++] ?? "",
      ),
      `${configPath} has an unsupported value`,
    );
  };
  expect("export");
  expect("default");
  expect("defineConfig");
  expect("(");
  assert.equal(tokens[i], "{", `${configPath} needs a config object`);
  value(true);
  take(",");
  expect(")");
  take(";");
  assert.equal(i, tokens.length, `${configPath} has trailing config syntax`);
}
