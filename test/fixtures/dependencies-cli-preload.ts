globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  console.log(`REQUEST ${init?.body}`);
  return Response.json({ id: "dependent", repoSlug: "local/repo", status: "waiting" });
}) as typeof fetch;
