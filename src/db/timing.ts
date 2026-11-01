import type { Database, Statement } from "bun:sqlite";
import { stallReporter } from "../util/stall.ts";

export function timeStatements(db: Database) {
  const seen = new WeakSet<Statement>();
  for (const method of ["query", "prepare"] as const) {
    db[method] = new Proxy(db[method], {
      apply(target, receiver, args) {
        const statement = Reflect.apply(target, receiver, args) as Statement;
        if (seen.has(statement)) return statement;
        seen.add(statement);
        const shape = String(args[0])
          .replace(
            /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\b(?:0x[\da-f]+|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?[\d_]+)?)|\.[\d_]+(?:e[+-]?[\d_]+)?/gi,
            "?",
          )
          .replace(/\s+/g, " ")
          .trim();
        const name = `store.query-${Bun.hash(shape).toString(16)}`;
        for (const execution of ["run", "get", "all"] as const) {
          Object.defineProperty(statement, execution, {
            value: new Proxy(statement[execution], {
              apply(fn, self, params) {
                return stallReporter.activity(name, () => Reflect.apply(fn, self, params), 50);
              },
            }),
          });
        }
        return statement;
      },
    });
  }
}
