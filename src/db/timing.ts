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
            /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[:@$][a-z_][\w]*|\b(?:0x[\da-f]+|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?[\d_]+)?)|\.[\d_]+(?:e[+-]?[\d_]+)?/gi,
            (token) => (token.startsWith("--") || token.startsWith("/*") ? " " : "?"),
          )
          .replace(/\s+/g, " ")
          .trim();
        const verb = /^([a-z]+)\b/i.exec(shape)?.[1]?.toLowerCase() ?? "query";
        const table =
          /\b(?:from|into|update(?:\s+or\s+(?:rollback|abort|replace|fail|ignore))?)\s+([^\s(),;]+)/i.exec(
            shape,
          )?.[1];
        const readable = table && /^[a-z_][a-z_0-9]*$/i.test(table) ? `-${table.toLowerCase()}` : "";
        const name = `store.${verb}${readable}-${Bun.hash(shape).toString(16).padStart(16, "0").slice(0, 8)}`;
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
  db.transaction = new Proxy(db.transaction, {
    apply(target, receiver, args) {
      const transaction = Reflect.apply(target, receiver, args) as ReturnType<Database["transaction"]>;
      const modes = {
        default: transaction,
        deferred: transaction.deferred,
        immediate: transaction.immediate,
        exclusive: transaction.exclusive,
      };
      const wrapped = Object.fromEntries(
        Object.entries(modes).map(
          ([mode, fn]) =>
            [
              mode,
              function (this: unknown, ...params: unknown[]) {
                // Totals include inner statements; they are not additive with those activities.
                return stallReporter.activity(
                  `store.transaction-${mode}`,
                  () => Reflect.apply(fn, this, params),
                  50,
                );
              },
            ] as const,
        ),
      );
      const descriptors = {
        ...Object.getOwnPropertyDescriptors(transaction),
        ...Object.fromEntries(Object.entries(wrapped).map(([mode, value]) => [mode, { value }] as const)),
      };
      for (const fn of Object.values(wrapped)) Object.defineProperties(fn, descriptors);
      return wrapped.default;
    },
  });
}
