globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  console.log(
    `REQUEST ${init?.method} ${new URL(url).pathname} ${init?.headers && (init.headers as Record<string, string>)["content-type"]}`,
  );
  const action = url.split("/").at(-1);
  return Response.json({ id: "claude", state: action === "disable" ? "disabled" : "ok", reason: null });
}) as typeof fetch;
