// A bounded language of known class text and unresolved output barriers.
export type Output =
  | { kind: "text"; text: string }
  | { kind: "sequence"; children: Output[] }
  | { kind: "opaque" };
export const text = (value: string): Output => ({ kind: "text", text: value });
export const sequence = (...children: Output[]): Output => ({ kind: "sequence", children });
export const opaque: Output = { kind: "opaque" };

type Matcher = {
  size: number;
  hit: number;
  step: (state: number, char: string) => number;
  barrier: (state: number) => number;
  end: (state: number) => number;
};

export function targetMatcher(target: string): Matcher {
  const dead = target.length + 1;
  const hit = dead + 1;
  return {
    size: hit + 1,
    hit,
    step: (s, ch) =>
      s === hit
        ? hit
        : /[\t\n\f\r ]/.test(ch)
          ? s === target.length
            ? hit
            : 0
          : s < target.length && target[s] === ch
            ? s + 1
            : dead,
    barrier: (s) => (s === hit ? hit : dead),
    end: (s) => (s === target.length ? hit : s),
  };
}

export function budget(limit = 2_000_000) {
  let used = 0;
  return (amount: number) => {
    used += amount;
    if (used > limit) throw new Error("class output work limit");
  };
}

// Each relation has at most size² pairs, regardless of the output language size.
export function matches(root: Output, matcher: Matcher, charge = budget()): boolean {
  const { size } = matcher;
  const memo = new WeakMap<Output, Set<number>[]>();
  const identity = () => Array.from({ length: size }, (_, i) => new Set([i]));
  const relate = (node: Output, depth: number): Set<number>[] => {
    if (depth > 128) throw new Error("class output depth limit");
    const cached = memo.get(node);
    if (cached) return cached;
    let result: Set<number>[];
    if (node.kind === "text") {
      charge(size * (node.text.length + 1));
      result = identity().map((states) => {
        let state = states.values().next().value as number;
        for (let i = 0; i < node.text.length; i++) state = matcher.step(state, node.text.charAt(i));
        return new Set([state]);
      });
    } else if (node.kind === "opaque") {
      charge(size);
      result = identity().map(
        (states) => new Set([matcher.barrier(states.values().next().value as number)]),
      );
    } else {
      result = identity();
      for (const child of node.children) {
        const next = relate(child, depth + 1);
        result = result.map((states) => {
          const out = new Set<number>();
          for (const state of states) {
            const ends = next[state] as Set<number>;
            charge(ends.size + 1);
            for (const end of ends) out.add(end);
          }
          return out;
        });
      }
    }
    memo.set(node, result);
    return result;
  };
  return [...(relate(root, 0)[0] as Set<number>)].some(
    (state) => matcher.end(state) === matcher.hit,
  );
}
