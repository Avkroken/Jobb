export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  BROWSER: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", targetApplicationsPerMonth: 10 });
    }

    return new Response("jobb — job application automation", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
