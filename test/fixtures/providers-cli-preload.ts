globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  console.log(
    `REQUEST ${init?.method} ${new URL(url).pathname} ${init?.headers && (init.headers as Record<string, string>)["content-type"]}`,
  );
  if (init?.body) console.log(`BODY ${init.body}`);
  const on = init?.body ? JSON.parse(String(init.body)).on : false;
  const action = url.split("/").at(-1);
  return Response.json({
    id: new URL(url).pathname.split("/")[3],
    fast: on,
    state: action === "disable" ? "disabled" : "ok",
    reason: null,
  });
}) as typeof fetch;
